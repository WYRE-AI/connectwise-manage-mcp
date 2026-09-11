import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";

export function registerAgreementTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_agreements",
    "Search finance agreements (recurring revenue contracts) in ConnectWise Manage. Use 'conditions' for CW query syntax (e.g. \"cancelledFlag = false\", \"company/name = 'Acme'\").",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/finance/agreements", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_agreement",
    "Get a specific finance agreement by ID.",
    {
      id: z.number().describe("Agreement ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/finance/agreements/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_agreement_additions",
    "Get additions (line items) for a specific agreement.",
    {
      agreementId: z.number().describe("Agreement ID"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ agreementId, page, pageSize }) => {
      const result = await client.get(`/finance/agreements/${agreementId}/additions`, {
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // The recap endpoints are the billing rollup ConnectWise computes per
  // agreement: amount consumed, amount remaining, overrun, and the last and
  // next invoice.
  //
  // The collection path keeps its trailing slash on purpose. ConnectWise's
  // published OpenAPI contract ("Connectwise Manage Public Endpoints", 2025.16)
  // documents `GET /finance/agreementrecap/` and the slash-less
  // `/finance/agreementrecap` appears nowhere in it — unlike its sibling
  // `/finance/agreements`, which has no slash. The by-id path, confusingly,
  // has no trailing slash. Do not "tidy" either one.
  server.tool(
    "cw_search_agreement_recaps",
    "Search agreement recaps — the billing rollup ConnectWise computes per agreement: starting, used, remaining, available and overrun amounts, unbilled periods, and the last and next invoice amount and date. Use this to answer agreement burn-down and overage questions without adding up additions by hand.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string (e.g. \"companyName like '%Acme%'\")"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by (e.g. 'remainingAmount asc')"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/finance/agreementrecap/", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_agreement_recap",
    "Get the billing recap for a specific agreement by agreement ID.",
    {
      id: z.number().describe("Agreement ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/finance/agreementrecap/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_search_invoices",
    "Search invoices in ConnectWise Manage.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string (e.g. \"company/name = 'Acme'\")"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by (e.g. 'id desc')"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/finance/invoices", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_invoice",
    "Get a specific invoice by ID.",
    {
      id: z.number().describe("Invoice ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/finance/invoices/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
