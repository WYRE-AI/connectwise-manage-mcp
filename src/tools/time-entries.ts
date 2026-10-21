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

export type TimeEntryClient = Pick<CwManageClient, "get" | "post" | "patch">;

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

function leftOffWarning(ticketId: number, flags: TicketEmailFlag[], restoreHint: string, err: unknown): string {
  const lines = flags.map(
    (flag) => `WARNING: ticket ${ticketId} ${flag} left false; turn it back on with ${restoreHint}`,
  );
  lines.push(`Restoring the ticket's Automatic Email flags failed: ${errorMessage(err)}`);
  return lines.join("\n");
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

function createdResult(entry: unknown, body: Record<string, unknown>, restoreWarning?: string): TimeEntryToolResult {
  const content: TimeEntryToolResult["content"] = [{ type: "text", text: JSON.stringify(entry, null, 2) }];
  if (restoreWarning) content.push({ type: "text", text: restoreWarning });
  const mismatches = flagMismatchWarnings(entry, body);
  if (mismatches.length > 0) content.push({ type: "text", text: mismatches.join("\n") });
  return restoreWarning ? { content, isError: true } : { content };
}

/**
 * Manage ignores the TimeEntry email flags on POST /time/entries and copies the
 * ticket's automaticEmailContactFlag / automaticEmailResourceFlag /
 * automaticEmailCcFlag onto the new entry, emailing those recipients. For a
 * service or project ticket, turn off each ticket flag whose entry flag was
 * requested false, create the entry, then turn the flags back on.
 *
 * Fails closed: if the ticket cannot be read or the flags cannot be turned
 * off, the entry is not created. If the restore fails, the entry is returned
 * with isError and a warning naming each flag left off.
 */
export async function createTimeEntryWithEmailGuard(
  client: TimeEntryClient,
  input: CreateTimeEntryToolInput,
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
      try {
        await setTicketFlags(client, target.path, toggled, true);
      } catch (restoreErr: unknown) {
        text += `\n\n${leftOffWarning(ticketId, toggled, target.restoreHint, restoreErr)}`;
      }
      return { content: [{ type: "text", text }], isError: true };
    }
  }

  let entry: unknown;
  let postError: unknown;
  let posted = false;
  let restoreError: unknown;
  let restoreFailed = false;
  try {
    entry = await client.post("/time/entries", body);
    posted = true;
  } catch (err: unknown) {
    postError = err;
  } finally {
    if (toggled.length > 0) {
      try {
        await setTicketFlags(client, target.path, toggled, true);
      } catch (err: unknown) {
        restoreFailed = true;
        restoreError = err;
      }
    }
  }

  const restoreWarning = restoreFailed
    ? leftOffWarning(ticketId, toggled, target.restoreHint, restoreError)
    : undefined;

  if (!posted) {
    if (!restoreWarning) return toolError(postError);
    return {
      content: [{ type: "text", text: `${errorMessage(postError)}\n\n${restoreWarning}` }],
      isError: true,
    };
  }
  return createdResult(entry, body, restoreWarning);
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
    "Create a new time entry. ConnectWise ignores emailContactFlag, emailResourceFlag and emailCcFlag on create and copies the ticket's automaticEmailContactFlag, automaticEmailResourceFlag and automaticEmailCcFlag onto the new entry, so sending false alone does not stop the email. For ServiceTicket and ProjectTicket, this tool turns off each ticket flag whose entry flag is false (the default) for the instant of the create, then turns it back on. If it cannot read or turn off a flag, the entry is not created. If the restore fails, the entry is returned as an error with a warning naming the flags left off. During that brief window other entries on the ticket miss auto-email, and the ticket PATCH updates its lastUpdated. suppressTicketAutoEmail=false skips the toggle and uses ConnectWise's default behaviour. ChargeCode and Activity entries make no ticket calls. emailCc is sent only when you provide it.",
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
