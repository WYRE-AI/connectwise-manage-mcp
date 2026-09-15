import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";

/**
 * Schedule entries book a member's time against a ticket, activity or project.
 * They are distinct from time entries: a schedule entry is the forward booking,
 * a time entry is the record of work done. Schedule entries also sync to the
 * member's Outlook calendar, so booking here avoids double entry in Outlook.
 *
 * Timezone: ConnectWise stores and returns dateStart / dateEnd in UTC, marked
 * with a trailing "Z". Perth (AWST) is UTC+8 with no daylight saving, so a
 * 10:00 Perth booking is sent as 02:00Z on the same date. A Perth time before
 * 08:00 falls on the previous UTC date.
 */

const UTC_NOTE =
  "ConnectWise interprets dateStart and dateEnd as UTC (trailing 'Z'). Perth (AWST) is UTC+8 with no daylight saving, so 10:00 Perth is 02:00Z and a Perth time before 08:00 lands on the previous UTC date.";

export function registerScheduleTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_schedule_entries",
    "Search schedule entries (booked resource time) in ConnectWise Manage. Use 'conditions' for CW query syntax (e.g. \"member/id = 147 and type/id = 4\"). Each entry carries objectId (the ticket, activity or project ticket it is booked against), member, dateStart, dateEnd, type, status, reminder, doneFlag and hours. " +
      UTC_NOTE,
    {
      conditions: z
        .string()
        .optional()
        .describe(
          "ConnectWise conditions query string (e.g. \"member/id = 147 and dateStart >= [2026-09-22T00:00:00Z]\"). Date literals go in square brackets and are UTC.",
        ),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z
        .number()
        .optional()
        .describe("Results per page (default: 25, max: 1000)"),
      orderBy: z
        .string()
        .optional()
        .describe("Field to order by (e.g. 'dateStart asc')"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/schedule/entries", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_list_schedule_types",
    "List schedule types in ConnectWise Manage. The type decides what kind of object the entry books against, so call this before creating an entry. Typical identifiers are 'S' for Service (a service ticket), 'P' for Project, 'C' for Sales and 'N' for Meeting.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ conditions, page, pageSize }) => {
      const result = await client.get("/schedule/types", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_list_schedule_statuses",
    "List schedule statuses in ConnectWise Manage. Statuses are usually 'Tentative' and 'Firm', one of which is flagged as the instance default.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ conditions, page, pageSize }) => {
      const result = await client.get("/schedule/statuses", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_create_schedule_entry",
    "Book resource time by creating a schedule entry against a ticket, activity or project ticket. This is the forward booking, not the record of work done: use cw_create_time_entry for that. The entry syncs to the member's Outlook calendar, so there is no need to book the same work in Outlook separately. memberId is required and never assumed, so confirm who the booking is for before calling. " +
      UTC_NOTE,
    {
      objectId: z
        .number()
        .describe(
          "ID of the object being booked against: the service ticket ID for a Service type entry, the project ticket ID for a Project type entry, or the activity ID for a Sales type entry",
        ),
      typeId: z
        .number()
        .describe(
          "Schedule type ID from cw_list_schedule_types. Use the 'S' (Service) type for a service ticket",
        ),
      memberId: z
        .number()
        .describe(
          "Member ID the time is booked for. Required and never defaulted: confirm the member before booking",
        ),
      dateStart: z
        .string()
        .describe(
          "Start of the booking in UTC ISO 8601 (e.g. '2026-09-22T02:00:00Z' is 10:00 Perth time)",
        ),
      dateEnd: z
        .string()
        .describe(
          "End of the booking in UTC ISO 8601 (e.g. '2026-09-22T03:00:00Z' is 11:00 Perth time)",
        ),
      statusId: z
        .number()
        .optional()
        .describe(
          "Schedule status ID from cw_list_schedule_statuses (e.g. Tentative or Firm). Defaults to the instance default status",
        ),
      reminderId: z
        .number()
        .optional()
        .describe(
          "Reminder lead time ID, as carried on existing entries (commonly 1 = 0 minutes, 2 = 5 minutes, 4 = 15 minutes). ConnectWise exposes no list endpoint for these, so read one off an existing entry with cw_search_schedule_entries",
        ),
      whereId: z
        .number()
        .optional()
        .describe(
          "Service location ID for where the work happens (e.g. On-Site, In-house, Remote)",
        ),
      spanId: z
        .number()
        .optional()
        .describe(
          "Schedule span ID, which controls whether the entry spans working hours or a full day",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "Entry name. ConnectWise generates one from the linked object when omitted",
        ),
      hours: z
        .number()
        .optional()
        .describe(
          "Booked hours. ConnectWise derives this from dateStart and dateEnd when omitted",
        ),
      doneFlag: z
        .boolean()
        .optional()
        .describe("Mark the booking as done (default: false)"),
      ownerFlag: z
        .boolean()
        .optional()
        .describe("Mark the member as the owner of the entry"),
      acknowledgedFlag: z
        .boolean()
        .optional()
        .describe("Mark the entry as acknowledged by the member"),
      allowScheduleConflictsFlag: z
        .boolean()
        .optional()
        .describe(
          "Allow the booking even where it overlaps an existing entry for the member (default: false)",
        ),
    },
    async ({
      objectId,
      typeId,
      memberId,
      dateStart,
      dateEnd,
      statusId,
      reminderId,
      whereId,
      spanId,
      name,
      hours,
      doneFlag,
      ownerFlag,
      acknowledgedFlag,
      allowScheduleConflictsFlag,
    }) => {
      const body: Record<string, unknown> = {
        objectId,
        type: { id: typeId },
        member: { id: memberId },
        dateStart,
        dateEnd,
      };
      if (statusId) body.status = { id: statusId };
      if (reminderId) body.reminder = { id: reminderId };
      if (whereId) body.where = { id: whereId };
      if (spanId) body.span = { id: spanId };
      if (name) body.name = name;
      if (hours !== undefined) body.hours = hours;
      if (doneFlag !== undefined) body.doneFlag = doneFlag;
      if (ownerFlag !== undefined) body.ownerFlag = ownerFlag;
      if (acknowledgedFlag !== undefined) body.acknowledgedFlag = acknowledgedFlag;
      if (allowScheduleConflictsFlag !== undefined) {
        body.allowScheduleConflictsFlag = allowScheduleConflictsFlag;
      }

      const result = await client.post("/schedule/entries", body);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_update_schedule_entry",
    "Update an existing schedule entry using JSON Patch operations. Use this to move a booking, change its status, or mark it done. There is deliberately no delete tool: removing booked time stays a manual action in ConnectWise. " +
      UTC_NOTE,
    {
      id: z.number().describe("Schedule entry ID"),
      operations: z
        .array(
          z.object({
            op: z.enum(["replace", "add", "remove"]).describe("Patch operation"),
            path: z
              .string()
              .describe(
                "JSON path (e.g. 'dateStart', 'dateEnd', 'status/id', 'member/id', 'doneFlag')",
              ),
            value: z.unknown().optional().describe("New value"),
          }),
        )
        .describe("Array of JSON Patch operations"),
    },
    async ({ id, operations }) => {
      const result = await client.patch(`/schedule/entries/${id}`, operations);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
