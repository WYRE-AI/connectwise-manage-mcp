import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import { customFieldConditionsSchema } from "./custom-field-conditions.js";

export function registerActivityTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_activities",
    "Search schedule activities in ConnectWise Manage. Filter on custom fields with 'customFieldConditions' (e.g. caption=\"Contract Type\" AND value=\"Managed\").",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      customFieldConditions: customFieldConditionsSchema,
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by"),
    },
    async ({ conditions, customFieldConditions, page, pageSize, orderBy }) => {
      const result = await client.get("/sales/activities", {
        conditions,
        customFieldConditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_activity",
    "Get a specific activity by ID.",
    {
      id: z.number().describe("Activity ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/sales/activities/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_create_activity",
    "Create a new activity.",
    {
      name: z.string().describe("Activity name/subject"),
      typeId: z.number().optional().describe("Activity type ID"),
      companyId: z.number().optional().describe("Company ID"),
      contactId: z.number().optional().describe("Contact ID"),
      memberId: z.number().optional().describe("Assigned member ID"),
      notes: z.string().optional().describe("Activity notes"),
      dateStart: z.string().optional().describe("Start date (ISO 8601)"),
      dateEnd: z.string().optional().describe("End date (ISO 8601)"),
    },
    async ({ name, typeId, companyId, contactId, memberId, notes, dateStart, dateEnd }) => {
      const body: Record<string, unknown> = { name };
      if (typeId) body.type = { id: typeId };
      if (companyId) body.company = { id: companyId };
      if (contactId) body.contact = { id: contactId };
      if (memberId) body.assignTo = { id: memberId };
      if (notes) body.notes = notes;
      if (dateStart) body.dateStart = dateStart;
      if (dateEnd) body.dateEnd = dateEnd;

      const result = await client.post("/sales/activities", body);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
