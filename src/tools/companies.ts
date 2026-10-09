import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";

export function registerCompanyTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_companies",
    "Search companies in ConnectWise Manage. Use 'conditions' for CW query syntax (e.g. \"name like '%Acme%'\").",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/company/companies", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_company",
    "Get a specific company by ID.",
    {
      id: z.number().describe("Company ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/company/companies/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_create_company",
    "Create a new company.",
    {
      name: z.string().describe("Company name"),
      identifier: z.string().describe("Unique company identifier (short code)"),
      typeIds: z.array(z.number()).optional().describe("Array of company type IDs"),
      statusId: z.number().optional().describe("Company status ID"),
      addressLine1: z.string().optional().describe("Street address"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State/province"),
      zip: z.string().optional().describe("Postal/ZIP code"),
      country: z.string().optional().describe("Country"),
      phoneNumber: z.string().optional().describe("Phone number"),
      website: z.string().optional().describe("Website URL"),
      siteName: z.string().optional().describe("Name of the company's primary site (default: \"Main\"). ConnectWise requires a site name."),
    },
      async ({ name, identifier, typeIds, statusId, addressLine1, city, state, zip, country, phoneNumber, website, siteName }) => {
           const body: Record<string, unknown> = { name, identifier, site: { name: siteName || "Main" } };
      if (typeIds?.length) body.types = typeIds.map((id) => ({ id }));
      if (statusId) body.status = { id: statusId };
      if (addressLine1) body.addressLine1 = addressLine1;
      if (city) body.city = city;
      if (state) body.state = state;
      if (zip) body.zip = zip;
      if (country) body.country = { name: country };
      if (phoneNumber) body.phoneNumber = phoneNumber;
      if (website) body.website = website;

      const result = await client.post("/company/companies", body);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_update_company",
    "Update an existing company using JSON Patch operations.",
    {
      id: z.number().describe("Company ID"),
      operations: z
        .array(
          z.object({
            op: z.enum(["replace", "add", "remove"]).describe("Patch operation"),
            path: z.string().describe("JSON path (e.g. 'name', 'phoneNumber')"),
            value: z.unknown().optional().describe("New value"),
          }),
        )
        .describe("Array of JSON Patch operations"),
    },
    async ({ id, operations }) => {
      const result = await client.patch(`/company/companies/${id}`, operations);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
