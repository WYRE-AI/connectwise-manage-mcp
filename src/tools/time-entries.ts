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
 * TimeEntry email flags are action flags. Manage fills an omitted
 * `emailContactFlag` from the ticket `automaticEmailContactFlag`, which is
 * commonly true, so the entry emails the contact. Always send false unless
 * the caller set the flag. `emailCc` is included only when the caller set it.
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
    "Create a new time entry. emailContactFlag, emailResourceFlag, and emailCcFlag are sent as false unless you set them. Manage treats an omitted emailContactFlag as the ticket automaticEmailContactFlag, which is often true and emails the customer; this tool never omits them and never defaults them to true. Set a flag to true only when that recipient should be emailed. emailCc is sent only when you provide it, and does not email anyone unless emailCcFlag is true.",
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
        .describe("Email the ticket contact for this entry. Omit to send false. Never defaults to true."),
      emailResourceFlag: z
        .boolean()
        .optional()
        .describe("Email ticket resources for this entry. Omit to send false. Never defaults to true."),
      emailCcFlag: z
        .boolean()
        .optional()
        .describe("Email the addresses in emailCc for this entry. Omit to send false. Never defaults to true."),
      emailCc: z
        .string()
        .optional()
        .describe("CC email addresses. Sent only when provided. Does not email anyone unless emailCcFlag is true."),
    },
    async (input) => {
      const body = buildCreateTimeEntryBody(input);
      try {
        const result = await client.post("/time/entries", body);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        return toolError(err);
      }
    },
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
