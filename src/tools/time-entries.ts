import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";

export interface CreateTimeEntryInput {
  chargeToType: "ServiceTicket" | "ProjectTicket" | "ChargeCode" | "Activity";
  chargeToId: number;
  memberId: number;
  timeStart: string;
  timeEnd?: string;
  actualHours?: number;
  notes?: string;
  internalNotes?: string;
  workTypeId?: number;
  workRoleId?: number;
  emailContactFlag?: boolean;
  emailResourceFlag?: boolean;
  emailCcFlag?: boolean;
  emailCc?: string;
}

/**
 * Builds the POST /time/entries body. The email flags are sent as false unless
 * the caller set them. Manage does not honor them on create: it copies the
 * ticket's automaticEmail* flags onto the entry (see
 * createTimeEntryWithEmailGuard). `emailCc` is included only when the caller
 * set it.
 */
export function buildCreateTimeEntryBody(input: CreateTimeEntryInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    chargeToType: input.chargeToType,
    chargeToId: input.chargeToId,
    member: { id: input.memberId },
    timeStart: input.timeStart,
    emailContactFlag: input.emailContactFlag ?? false,
    emailResourceFlag: input.emailResourceFlag ?? false,
    emailCcFlag: input.emailCcFlag ?? false,
  };
  if (input.timeEnd) body.timeEnd = input.timeEnd;
  if (input.actualHours !== undefined) body.actualHours = input.actualHours;
  if (input.notes) body.notes = input.notes;
  if (input.internalNotes) body.internalNotes = input.internalNotes;
  if (input.workTypeId) body.workType = { id: input.workTypeId };
  if (input.workRoleId) body.workRole = { id: input.workRoleId };
  if (input.emailCc !== undefined) body.emailCc = input.emailCc;
  return body;
}

function toolError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: msg }], isError: true as const };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface CreateTimeEntryToolInput extends CreateTimeEntryInput {
  /** Default true. false skips the ticket flag toggle (Manage's default behaviour). */
  suppressTicketAutoEmail?: boolean;
}

export type TimeEntryClient = Pick<CwManageClient, "get" | "post" | "patch"> & {
  /** Non-secret tenant identity (API base URL + company id); keys the per-ticket lock. */
  readonly connectionKey?: string;
};

/**
 * Per-ticket async lock (promise-chain mutex), in-process only.
 *
 * The guarded create is read flags -> turn off -> POST entry -> restore, and
 * ConnectWise has no ticket lock. Two concurrent creates on one ticket could
 * interleave so that one entry is posted while the other has already restored
 * the flags (or one reads the other's "off" state as the original), and the
 * recipient is emailed. Serializing the whole sequence per ticket closes that
 * within this process.
 *
 * Limit: this only serializes calls inside one process (one stdio server, one
 * Node HTTP server, or one Worker isolate). It does not coordinate across
 * replicas, separate Worker isolates, or other ConnectWise integrations and
 * humans editing the same ticket.
 *
 * Each waiter chains on the previous tail with its rejection swallowed, so one
 * failure never poisons later callers; the map entry is deleted once the last
 * holder finishes, so idle tickets do not leak.
 */
const ticketLocks = new Map<string, Promise<void>>();

/** Fallback lock identity for a client with no connectionKey (one id per client object). */
const anonymousClientKeys = new WeakMap<object, string>();
let anonymousClientCounter = 0;

function clientLockKey(client: TimeEntryClient): string {
  if (typeof client.connectionKey === "string" && client.connectionKey) return client.connectionKey;
  let key = anonymousClientKeys.get(client);
  if (!key) {
    key = `client#${++anonymousClientCounter}`;
    anonymousClientKeys.set(client, key);
  }
  return key;
}

export async function withTicketLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = ticketLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  ticketLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (ticketLocks.get(key) === tail) ticketLocks.delete(key);
  }
}

/** Number of tickets with a held or queued lock. Exposed for tests. */
export function activeTicketLockCount(): number {
  return ticketLocks.size;
}

export type TimeEntryToolResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

type EntryEmailFlag = "emailContactFlag" | "emailResourceFlag" | "emailCcFlag";
type TicketEmailFlag =
  | "automaticEmailContactFlag"
  | "automaticEmailResourceFlag"
  | "automaticEmailCcFlag";

const EMAIL_FLAG_PAIRS: readonly { entry: EntryEmailFlag; ticket: TicketEmailFlag }[] = [
  { entry: "emailContactFlag", ticket: "automaticEmailContactFlag" },
  { entry: "emailResourceFlag", ticket: "automaticEmailResourceFlag" },
  { entry: "emailCcFlag", ticket: "automaticEmailCcFlag" },
];

function ticketTarget(input: CreateTimeEntryInput): { path: string; restoreHint: string } | undefined {
  if (input.chargeToType === "ServiceTicket") {
    return { path: `/service/tickets/${input.chargeToId}`, restoreHint: "cw_update_ticket" };
  }
  if (input.chargeToType === "ProjectTicket") {
    // No MCP tool patches project tickets, so name the API call.
    const path = `/project/tickets/${input.chargeToId}`;
    return { path, restoreHint: `PATCH ${path}` };
  }
  return undefined;
}

function setTicketFlags(client: TimeEntryClient, path: string, flags: TicketEmailFlag[], value: boolean) {
  return client.patch(
    path,
    flags.map((flag) => ({ op: "replace", path: flag, value })),
  );
}

function leftOffWarning(
  ticketId: number,
  flags: TicketEmailFlag[],
  restoreHint: string,
  err: unknown,
  attempts: number,
): string {
  const lines = flags.map(
    (flag) => `WARNING: ticket ${ticketId} ${flag} left false; turn it back on with ${restoreHint}`,
  );
  lines.push(
    `Restoring the ticket's Automatic Email flags failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${errorMessage(err)}`,
  );
  return lines.join("\n");
}

/** Total tries at turning the ticket flags back on (first try plus retries). */
export const RESTORE_ATTEMPTS = 3;
/** Wait before each retry of the restore, in ms. The last value repeats if attempts outnumber it. */
export const RESTORE_BACKOFF_MS: readonly number[] = [200, 600];

export interface EmailGuardOptions {
  /** Overrides RESTORE_BACKOFF_MS (tests pass [0, 0]). */
  restoreBackoffMs?: readonly number[];
}

type RestoreOutcome = { ok: true; attempts: number } | { ok: false; attempts: number; error: unknown };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Turns the ticket flags back on, retrying a failed PATCH up to
 * RESTORE_ATTEMPTS times in total with a short backoff. A transient
 * ConnectWise error (429, 5xx, a dropped socket) then does not leave the
 * ticket's automatic email silently off. Runs inside the ticket lock.
 */
async function restoreTicketFlags(
  client: TimeEntryClient,
  path: string,
  flags: TicketEmailFlag[],
  backoffMs: readonly number[],
): Promise<RestoreOutcome> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt++) {
    try {
      await setTicketFlags(client, path, flags, true);
      return { ok: true, attempts: attempt };
    } catch (err: unknown) {
      lastError = err;
      if (attempt < RESTORE_ATTEMPTS) {
        const wait = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0;
        if (wait > 0) await sleep(wait);
      }
    }
  }
  return { ok: false, attempts: RESTORE_ATTEMPTS, error: lastError };
}

/**
 * One error-level JSON line on stderr when the restore gives up, so an
 * operator can find the ticket and turn the flags back on. It carries the
 * non-secret connection identity (API base URL + company id), never keys.
 * The error text has already been through safe-error (status, reference id,
 * redacted 4xx detail).
 */
function logRestoreFailure(details: {
  client: TimeEntryClient;
  ticketId: number;
  ticketPath: string;
  flagsLeftOff: TicketEmailFlag[];
  timeEntryCreated: boolean;
  timeEntryId?: unknown;
  attempts: number;
  error: unknown;
}): void {
  const line: Record<string, unknown> = {
    level: "error",
    event: "cw_time_entry_auto_email_restore_failed",
    ticketId: details.ticketId,
    ticketPath: details.ticketPath,
    flagsLeftOff: details.flagsLeftOff,
    timeEntryCreated: details.timeEntryCreated,
    attempts: details.attempts,
    error: errorMessage(details.error),
  };
  if (details.timeEntryId !== undefined) line.timeEntryId = details.timeEntryId;
  if (typeof details.client.connectionKey === "string" && details.client.connectionKey) {
    line.connection = details.client.connectionKey;
  }
  console.error(JSON.stringify(line));
}

function entryId(entry: unknown): unknown {
  return entry && typeof entry === "object" ? (entry as Record<string, unknown>).id : undefined;
}

/** Warns where Manage stored an entry email flag other than the one requested. */
function flagMismatchWarnings(entry: unknown, body: Record<string, unknown>): string[] {
  if (!entry || typeof entry !== "object") return [];
  const record = entry as Record<string, unknown>;
  const warnings: string[] = [];
  for (const { entry: flag } of EMAIL_FLAG_PAIRS) {
    const stored = record[flag];
    if (typeof stored === "boolean" && stored !== body[flag]) {
      warnings.push(
        `ConnectWise stored ${flag}=${stored} on time entry ${String(record.id)} though ${String(body[flag])} was requested;` +
          (stored ? " the recipient may have been emailed." : " the recipient was not emailed."),
      );
    }
  }
  return warnings;
}

function createdResult(entry: unknown, body: Record<string, unknown>): TimeEntryToolResult {
  const content: TimeEntryToolResult["content"] = [{ type: "text", text: JSON.stringify(entry, null, 2) }];
  const mismatches = flagMismatchWarnings(entry, body);
  if (mismatches.length > 0) content.push({ type: "text", text: mismatches.join("\n") });
  return { content };
}

/**
 * The entry was created but the ticket flags could not be turned back on.
 * Not isError: the create succeeded, and an error result invites the caller
 * to retry and log the time twice. The first block is a prominent warning
 * that the entry exists and which flags are still off; the last is a JSON
 * status block (timeEntryCreated, timeEntryId, autoEmailRestoreFailed,
 * flagsLeftOff, restoreWith) for programmatic callers.
 */
function createdWithRestoreFailure(
  entry: unknown,
  body: Record<string, unknown>,
  ticketId: number,
  flagsLeftOff: TicketEmailFlag[],
  restoreHint: string,
  attempts: number,
  err: unknown,
): TimeEntryToolResult {
  const id = entryId(entry);
  const headline =
    `WARNING: time entry ${String(id)} WAS created on ticket ${ticketId}. Do not create it again. ` +
    `Its Automatic Email flags could not be turned back on, so ticket ${ticketId} will not auto-email ` +
    `these recipients until they are restored: ${flagsLeftOff.join(", ")}.`;
  const content: TimeEntryToolResult["content"] = [
    { type: "text", text: `${headline}\n${leftOffWarning(ticketId, flagsLeftOff, restoreHint, err, attempts)}` },
    { type: "text", text: JSON.stringify(entry, null, 2) },
  ];
  const mismatches = flagMismatchWarnings(entry, body);
  if (mismatches.length > 0) content.push({ type: "text", text: mismatches.join("\n") });
  content.push({
    type: "text",
    text: JSON.stringify(
      {
        timeEntryCreated: true,
        timeEntryId: id ?? null,
        autoEmailRestoreFailed: true,
        ticketId,
        flagsLeftOff,
        restoreAttempts: attempts,
        restoreWith: restoreHint,
      },
      null,
      2,
    ),
  });
  return { content };
}

/**
 * Manage ignores the TimeEntry email flags on POST /time/entries and copies the
 * ticket's automaticEmailContactFlag / automaticEmailResourceFlag /
 * automaticEmailCcFlag onto the new entry, emailing those recipients. For a
 * service or project ticket, turn off each ticket flag whose entry flag was
 * requested false, create the entry, then turn the flags back on.
 *
 * Fails closed: if the ticket cannot be read or the flags cannot be turned
 * off, the entry is not created. The restore is retried (RESTORE_ATTEMPTS
 * tries with RESTORE_BACKOFF_MS between them). If every try fails after the
 * entry was created, the result is not isError (the entry exists and must not
 * be created again): it leads with a warning naming the entry and each flag
 * left off, ends with a JSON status block (autoEmailRestoreFailed: true), and
 * an error-level line is logged.
 *
 * The read/toggle/post/restore sequence is serialized per ticket (keyed by the
 * client's connectionKey plus the ticket path) within this process only; see
 * withTicketLock for what that does not cover.
 */
export async function createTimeEntryWithEmailGuard(
  client: TimeEntryClient,
  input: CreateTimeEntryToolInput,
  options: EmailGuardOptions = {},
): Promise<TimeEntryToolResult> {
  const body = buildCreateTimeEntryBody(input);
  const target = input.suppressTicketAutoEmail === false ? undefined : ticketTarget(input);

  if (!target) {
    try {
      return createdResult(await client.post("/time/entries", body), body);
    } catch (err: unknown) {
      return toolError(err);
    }
  }

  const ticketId = input.chargeToId;
  const wantedOff = EMAIL_FLAG_PAIRS.filter((pair) => body[pair.entry] === false);
  if (wantedOff.length === 0) {
    try {
      return createdResult(await client.post("/time/entries", body), body);
    } catch (err: unknown) {
      return toolError(err);
    }
  }

  return withTicketLock(`${clientLockKey(client)}|${target.path}`, () =>
    guardedCreate(client, body, target, ticketId, wantedOff, options.restoreBackoffMs ?? RESTORE_BACKOFF_MS),
  );
}

/** Read flags, turn off, POST, restore. Always runs under withTicketLock for the ticket. */
async function guardedCreate(
  client: TimeEntryClient,
  body: Record<string, unknown>,
  target: { path: string; restoreHint: string },
  ticketId: number,
  wantedOff: readonly { entry: EntryEmailFlag; ticket: TicketEmailFlag }[],
  backoffMs: readonly number[],
): Promise<TimeEntryToolResult> {
  let ticket: Record<string, unknown>;
  try {
    ticket =
      (await client.get<Record<string, unknown> | null>(target.path, {
        fields: EMAIL_FLAG_PAIRS.map((pair) => pair.ticket).join(","),
      })) ?? {};
  } catch (err: unknown) {
    const flags = wantedOff.map((pair) => pair.ticket).join(", ");
    return {
      content: [
        {
          type: "text",
          text:
            `Time entry not created: could not read ticket ${ticketId} Automatic Email flags (${flags}), ` +
            `and ConnectWise would have emailed the recipients for any that are on. ${errorMessage(err)}`,
        },
      ],
      isError: true,
    };
  }

  const toggled = wantedOff.filter((pair) => ticket[pair.ticket] === true).map((pair) => pair.ticket);

  if (toggled.length > 0) {
    try {
      await setTicketFlags(client, target.path, toggled, false);
    } catch (err: unknown) {
      let text =
        `Time entry not created: ConnectWise would have emailed the recipients because ticket ${ticketId} has ` +
        `${toggled.join(", ")} on, and turning ${toggled.length === 1 ? "it" : "them"} off failed. ${errorMessage(err)}`;
      // The PATCH may have applied partway; put the flags back.
      const restore = await restoreTicketFlags(client, target.path, toggled, backoffMs);
      if (!restore.ok) {
        logRestoreFailure({
          client,
          ticketId,
          ticketPath: target.path,
          flagsLeftOff: toggled,
          timeEntryCreated: false,
          attempts: restore.attempts,
          error: restore.error,
        });
        text += `\n\n${leftOffWarning(ticketId, toggled, target.restoreHint, restore.error, restore.attempts)}`;
      }
      return { content: [{ type: "text", text }], isError: true };
    }
  }

  let entry: unknown;
  let postError: unknown;
  let posted = false;
  let restore: RestoreOutcome | undefined;
  try {
    entry = await client.post("/time/entries", body);
    posted = true;
  } catch (err: unknown) {
    postError = err;
  } finally {
    if (toggled.length > 0) {
      restore = await restoreTicketFlags(client, target.path, toggled, backoffMs);
    }
  }

  if (restore && !restore.ok) {
    logRestoreFailure({
      client,
      ticketId,
      ticketPath: target.path,
      flagsLeftOff: toggled,
      timeEntryCreated: posted,
      timeEntryId: posted ? entryId(entry) : undefined,
      attempts: restore.attempts,
      error: restore.error,
    });
    if (posted) {
      return createdWithRestoreFailure(entry, body, ticketId, toggled, target.restoreHint, restore.attempts, restore.error);
    }
    const warning = leftOffWarning(ticketId, toggled, target.restoreHint, restore.error, restore.attempts);
    return {
      content: [
        {
          type: "text",
          text: `Time entry not created: ${errorMessage(postError)}\n\n${warning}`,
        },
      ],
      isError: true,
    };
  }

  if (!posted) return toolError(postError);
  return createdResult(entry, body);
}

export function registerTimeEntryTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_time_entries",
    "Search time entries in ConnectWise Manage.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string (e.g. \"member/identifier = 'jsmith'\")"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/time/entries", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_time_entry",
    "Get a specific time entry by ID.",
    {
      id: z.number().describe("Time entry ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/time/entries/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_create_time_entry",
    "Create a new time entry. ConnectWise ignores emailContactFlag, emailResourceFlag and emailCcFlag on create and copies the ticket's automaticEmailContactFlag, automaticEmailResourceFlag and automaticEmailCcFlag onto the new entry, so sending false alone does not stop the email. For ServiceTicket and ProjectTicket, this tool turns off each ticket flag whose entry flag is false (the default) for the instant of the create, then turns it back on. If it cannot read or turn off a flag, the entry is not created. Turning the flags back on is tried up to 3 times. If every try fails, the entry WAS created and the result is not an error: it starts with a WARNING naming the time entry id and each ticket flag left off, and ends with a JSON block with timeEntryCreated true, timeEntryId, autoEmailRestoreFailed true and flagsLeftOff. Do not create the entry again; turn the flags back on with cw_update_ticket (or PATCH the project ticket). Concurrent calls on the same ticket are serialized within this server process only, not across replicas or separate Worker isolates, so run this server as a single replica if concurrent creates on one ticket are possible. During that brief window other entries on the ticket (from other processes or users) miss auto-email, and the ticket PATCH updates its lastUpdated. suppressTicketAutoEmail=false skips the toggle and uses ConnectWise's default behaviour. ChargeCode and Activity entries make no ticket calls. emailCc is sent only when you provide it.",
    {
      chargeToType: z.enum(["ServiceTicket", "ProjectTicket", "ChargeCode", "Activity"]).describe("What to charge the time to"),
      chargeToId: z.number().describe("ID of the ticket, charge code, or activity"),
      memberId: z.number().describe("Member ID for the time entry"),
      timeStart: z.string().describe("Start time (ISO 8601)"),
      timeEnd: z.string().optional().describe("End time (ISO 8601)"),
      actualHours: z.number().optional().describe("Actual hours worked (alternative to timeEnd)"),
      notes: z.string().optional().describe("Work notes"),
      internalNotes: z.string().optional().describe("Internal-only notes"),
      workTypeId: z.number().optional().describe("Work type ID"),
      workRoleId: z.number().optional().describe("Work role ID"),
      emailContactFlag: z
        .boolean()
        .optional()
        .describe("Email the ticket contact. Default false. While false, the ticket's automaticEmailContactFlag is turned off for the create (see suppressTicketAutoEmail)."),
      emailResourceFlag: z
        .boolean()
        .optional()
        .describe("Email ticket resources. Default false. While false, the ticket's automaticEmailResourceFlag is turned off for the create (see suppressTicketAutoEmail)."),
      emailCcFlag: z
        .boolean()
        .optional()
        .describe("Email the ticket CC addresses. Default false. While false, the ticket's automaticEmailCcFlag is turned off for the create (see suppressTicketAutoEmail)."),
      emailCc: z
        .string()
        .optional()
        .describe("CC email addresses. Sent only when provided."),
      suppressTicketAutoEmail: z
        .boolean()
        .optional()
        .describe("Default true. For service and project tickets, turn off the ticket's automaticEmail* flags matching false entry flags for the instant of the create, then restore them. false makes no ticket calls, so ConnectWise emails whoever the ticket flags say."),
    },
    async (input) => createTimeEntryWithEmailGuard(client, input),
  );

  server.tool(
    "cw_update_time_entry",
    "Update a time entry with JSON Patch (Manage PATCH /time/entries/{id}). Use this to correct a mistaken entry, including actualHours on a metered agreement (those hours round to 0.25). Paths are field names such as actualHours, notes, internalNotes, timeStart, timeEnd, or billableOption. Billed entries may be rejected by Manage.",
    {
      id: z.number().describe("Time entry ID"),
      operations: z
        .array(
          z.object({
            op: z.enum(["replace", "add", "remove"]).describe("Patch operation"),
            path: z.string().describe("Field path (e.g. 'actualHours', 'notes', 'timeEnd')"),
            value: z.unknown().optional().describe("New value"),
          }),
        )
        .describe("JSON Patch operations applied to the time entry"),
    },
    async ({ id, operations }) => {
      const result = await client.patch(`/time/entries/${id}`, operations);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_delete_time_entry",
    "Delete a time entry (Manage DELETE /time/entries/{id}). Use this to remove a mistaken entry before it is billed. Manage rejects deletes of entries that are already billed.",
    {
      id: z.number().describe("Time entry ID"),
    },
    async ({ id }) => {
      await client.delete(`/time/entries/${id}`);
      return {
        content: [{ type: "text", text: JSON.stringify({ id, deleted: true }, null, 2) }],
      };
    },
  );
}
