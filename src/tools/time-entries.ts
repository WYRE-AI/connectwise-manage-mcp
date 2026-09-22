import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";

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
    "Create a new time entry.",
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
    },
    async ({ chargeToType, chargeToId, memberId, timeStart, timeEnd, actualHours, notes, internalNotes, workTypeId, workRoleId }) => {
      const body: Record<string, unknown> = {
        chargeToType,
        chargeToId,
        member: { id: memberId },
        timeStart,
      };
      if (timeEnd) body.timeEnd = timeEnd;
      if (actualHours !== undefined) body.actualHours = actualHours;
      if (notes) body.notes = notes;
      if (internalNotes) body.internalNotes = internalNotes;
      if (workTypeId) body.workType = { id: workTypeId };
      if (workRoleId) body.workRole = { id: workRoleId };

      const result = await client.post("/time/entries", body);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
