import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";

export function registerOpportunityTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_opportunities",
    "Search sales opportunities in ConnectWise Manage. Use 'conditions' for CW query syntax (e.g. \"status/name = '1. Open'\", \"closedFlag = false\").",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by (e.g. 'id desc')"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/sales/opportunities", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_opportunity",
    "Get a specific sales opportunity by ID.",
    {
      id: z.number().describe("Opportunity ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/sales/opportunities/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_search_opportunity_forecasts",
    "Search opportunity forecasts/revenue items for a specific opportunity.",
    {
      opportunityId: z.number().describe("Opportunity ID"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ opportunityId, page, pageSize }) => {
      const result = await client.get(`/sales/opportunities/${opportunityId}/forecast`, {
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_search_opportunity_notes",
    "Get notes on a specific sales opportunity.",
    {
      opportunityId: z.number().describe("Opportunity ID"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ opportunityId, page, pageSize }) => {
      const result = await client.get(`/sales/opportunities/${opportunityId}/notes`, {
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_search_sales_stages",
    "List sales pipeline stages in ConnectWise Manage.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ conditions, page, pageSize }) => {
      const result = await client.get("/sales/stages", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
  server.tool(
    "cw_list_opportunity_statuses",
    "List sales opportunity statuses (e.g. Open, Won, Lost). Use the returned id as statusId in cw_create_opportunity.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string (e.g. \"inactiveFlag = false\")"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ conditions, page, pageSize }) => {
      const result = await client.get("/sales/opportunities/statuses", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_list_opportunity_types",
    "List sales opportunity types (e.g. New Business, Renewal). Use the returned id as typeId in cw_create_opportunity.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string (e.g. \"inactiveFlag = false\")"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ conditions, page, pageSize }) => {
      const result = await client.get("/sales/opportunities/types", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_create_opportunity",
    "Create a new sales opportunity for a company (Manage POST /sales/opportunities). " +
      "Only name and companyId are mandatory here: if contactId or siteId are omitted, the company's default contact and primary site are looked up and used. " +
      "Manage also requires a primary sales rep -- pass primarySalesRepId (member ID) or primarySalesRepIdentifier (member login, e.g. 'jdoe'); find them with cw_search_members. " +
      "Look up valid IDs with cw_search_sales_stages, cw_list_opportunity_statuses and cw_list_opportunity_types. " +
      "Set dryRun=true to preview the exact payload without creating anything.",
    {
      name: z.string().min(1).max(100).describe("Opportunity name (max 100 characters)"),
      companyId: z.number().int().describe("Company ID the opportunity is for (find it with cw_search_companies)"),
      contactId: z.number().int().optional().describe("Contact ID at the company (default: the company's default contact)"),
      siteId: z.number().int().optional().describe("Company site ID (default: the company's primary site)"),
      primarySalesRepId: z.number().int().optional().describe("Primary sales rep member ID"),
      primarySalesRepIdentifier: z.string().optional().describe("Primary sales rep member identifier/login (alternative to primarySalesRepId)"),
      secondarySalesRepId: z.number().int().optional().describe("Secondary sales rep member ID"),
      expectedCloseDate: z.string().optional().describe("Expected close date (ISO 8601, e.g. '2026-12-31' or '2026-12-31T00:00:00Z')"),
      stageId: z.number().int().optional().describe("Sales stage ID (see cw_search_sales_stages)"),
      statusId: z.number().int().optional().describe("Opportunity status ID (see cw_list_opportunity_statuses)"),
      typeId: z.number().int().optional().describe("Opportunity type ID (see cw_list_opportunity_types)"),
      probabilityId: z.number().int().optional().describe("Sales probability ID"),
      ratingId: z.number().int().optional().describe("Opportunity rating ID"),
      source: z.string().max(50).optional().describe("Lead source (free text, max 50 characters)"),
      notes: z.string().optional().describe("Opportunity notes / description"),
      customerPO: z.string().max(25).optional().describe("Customer purchase order number"),
      locationId: z.number().int().optional().describe("Location (territory) ID"),
      businessUnitId: z.number().int().optional().describe("Business unit (department) ID"),
      campaignId: z.number().int().optional().describe("Marketing campaign ID"),
      customFields: z
        .array(z.object({ id: z.number().int(), value: z.unknown() }))
        .optional()
        .describe("Custom field values, e.g. [{ id: 12, value: 'Inbound' }]"),
      dryRun: z.boolean().optional().describe("If true, return the payload that would be sent without creating the opportunity"),
    },
    async (args) => {
      const body = await buildOpportunityPayload(client, args);

      if (args.dryRun) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ dryRun: true, method: "POST", path: "/sales/opportunities", body }, null, 2),
            },
          ],
        };
      }

      const result = await client.post("/sales/opportunities", body);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_add_opportunity_note",
    "Add a note to an existing sales opportunity.",
    {
      opportunityId: z.number().int().describe("Opportunity ID"),
      text: z.string().min(1).describe("Note text"),
      typeId: z.number().int().optional().describe("Note type ID"),
      flagged: z.boolean().optional().describe("Flag the note (default: false)"),
    },
    async ({ opportunityId, text, typeId, flagged }) => {
      const body: Record<string, unknown> = { text };
      if (typeId !== undefined) body.type = { id: typeId };
      if (flagged !== undefined) body.flagged = flagged;
      const result = await client.post(`/sales/opportunities/${opportunityId}/notes`, body);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}

export interface CreateOpportunityArgs {
  name: string;
  companyId: number;
  contactId?: number;
  siteId?: number;
  primarySalesRepId?: number;
  primarySalesRepIdentifier?: string;
  secondarySalesRepId?: number;
  expectedCloseDate?: string;
  stageId?: number;
  statusId?: number;
  typeId?: number;
  probabilityId?: number;
  ratingId?: number;
  source?: string;
  notes?: string;
  customerPO?: string;
  locationId?: number;
  businessUnitId?: number;
  campaignId?: number;
  customFields?: { id: number; value?: unknown }[];
}

interface CompanyDefaults {
  defaultContact?: { id?: number };
  site?: { id?: number };
}

/** Normalise a date-only value ("2026-12-31") to the full ISO timestamp Manage expects. */
export function toCwDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
}

/**
 * Build the POST /sales/opportunities body. When contactId or siteId is
 * missing, the company record is fetched once to fill them from the
 * company's default contact and primary site.
 */
export async function buildOpportunityPayload(
  client: Pick<CwManageClient, "get">,
  args: CreateOpportunityArgs,
): Promise<Record<string, unknown>> {
  let contactId = args.contactId;
  let siteId = args.siteId;

  if (contactId === undefined || siteId === undefined) {
    const company = await client.get<CompanyDefaults>(`/company/companies/${args.companyId}`);
    contactId ??= company?.defaultContact?.id;
    siteId ??= company?.site?.id;
  }

  const body: Record<string, unknown> = {
    name: args.name,
    company: { id: args.companyId },
  };
  if (contactId !== undefined) body.contact = { id: contactId };
  if (siteId !== undefined) body.site = { id: siteId };

  if (args.primarySalesRepId !== undefined) body.primarySalesRep = { id: args.primarySalesRepId };
  else if (args.primarySalesRepIdentifier) body.primarySalesRep = { identifier: args.primarySalesRepIdentifier };
  if (args.secondarySalesRepId !== undefined) body.secondarySalesRep = { id: args.secondarySalesRepId };

  if (args.expectedCloseDate) body.expectedCloseDate = toCwDate(args.expectedCloseDate);
  if (args.stageId !== undefined) body.stage = { id: args.stageId };
  if (args.statusId !== undefined) body.status = { id: args.statusId };
  if (args.typeId !== undefined) body.type = { id: args.typeId };
  if (args.probabilityId !== undefined) body.probability = { id: args.probabilityId };
  if (args.ratingId !== undefined) body.rating = { id: args.ratingId };
  if (args.campaignId !== undefined) body.campaign = { id: args.campaignId };
  if (args.source) body.source = args.source;
  if (args.notes) body.notes = args.notes;
  if (args.customerPO) body.customerPO = args.customerPO;
  if (args.locationId !== undefined) body.locationId = args.locationId;
  if (args.businessUnitId !== undefined) body.businessUnitId = args.businessUnitId;
  if (args.customFields?.length) body.customFields = args.customFields;

  return body;
}
