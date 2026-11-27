import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import { customFieldConditionsSchema } from "./custom-field-conditions.js";
import { READ_ONLY } from "./annotations.js";

export function registerMemberTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_members",
    "Search members (technicians/users) in ConnectWise Manage. Filter on custom fields with 'customFieldConditions' (e.g. caption=\"Contract Type\" AND value=\"Managed\").",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string (e.g. \"identifier = 'jsmith'\")"),
      customFieldConditions: customFieldConditionsSchema,
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by"),
    },
    READ_ONLY,
    async ({ conditions, customFieldConditions, page, pageSize, orderBy }) => {
      const result = await client.get("/system/members", {
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
    "cw_get_member",
    "Get a specific member by ID.",
    {
      id: z.number().describe("Member ID"),
    },
    READ_ONLY,
    async ({ id }) => {
      const result = await client.get(`/system/members/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
