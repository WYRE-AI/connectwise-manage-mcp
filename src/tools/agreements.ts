import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";

const additionPatchOperation = z.object({
  op: z.enum(["replace", "add", "remove"]).describe("Patch operation"),
  path: z.string().describe("Field path (e.g. 'quantity', 'billCustomer', 'cancelledDate')"),
  value: z.unknown().optional().describe("New value"),
});

/**
 * Applies flat-field JSON Patch operations to a record in memory, matching
 * the same simple-path convention (top-level field names, not nested JSON
 * Pointers) that cw_update_time_entry documents. Used for cw_update_agreement_addition's
 * dryRun mode so a preview never has to round-trip through Manage.
 */
export function applyPatchLocally(
  record: Record<string, unknown>,
  operations: { op: "replace" | "add" | "remove"; path: string; value?: unknown }[],
): Record<string, unknown> {
  const patched = { ...record };
  for (const { op, path, value } of operations) {
    const field = path.replace(/^\//, "");
    if (op === "remove") {
      delete patched[field];
    } else {
      patched[field] = value;
    }
  }
  return patched;
}

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

  server.tool(
    "cw_update_agreement_addition",
    "Update an agreement addition (recurring line item) with JSON Patch (Manage PATCH /finance/agreements/{agreementId}/additions/{additionId}). Use this for seat-count reconciliation and similar corrections. Common paths: quantity, effectiveDate, cancelledDate, billCustomer ('Billable' | 'DoNotBill' | 'NoCharge'), description, invoiceDescription, unitPrice, unitCost. Set dryRun to preview the result without saving.",
    {
      agreementId: z.number().describe("Agreement ID"),
      additionId: z.number().describe("Addition (line item) ID"),
      operations: z.array(additionPatchOperation).describe("JSON Patch operations applied to the addition"),
      dryRun: z
        .boolean()
        .optional()
        .describe("If true, fetch the current addition, apply the patch locally, and return the would-be result without calling Manage (no write is made)."),
    },
    async ({ agreementId, additionId, operations, dryRun }) => {
      const path = `/finance/agreements/${agreementId}/additions/${additionId}`;
      if (dryRun) {
        const current = await client.get<Record<string, unknown>>(path);
        const preview = applyPatchLocally(current, operations);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ dryRun: true, saved: false, preview }, null, 2),
            },
          ],
        };
      }
      const result = await client.patch(path, operations);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_create_agreement_addition",
    "Create a new addition (recurring line item) on an agreement (Manage POST /finance/agreements/{agreementId}/additions). Requires a catalog item (productId) and billCustomer. NOTE: field coverage here was verified against a community-maintained ConnectWise Manage type reference, not the official REST docs directly -- if Manage rejects the create with a validation error on a field not listed here, that field is real but missing from this tool's schema.",
    {
      agreementId: z.number().describe("Agreement ID"),
      productId: z.number().describe("Catalog item (product) ID to add"),
      billCustomer: z.enum(["Billable", "DoNotBill", "NoCharge"]).describe("Billing treatment for this addition"),
      quantity: z.number().optional().describe("Quantity"),
      description: z.string().optional().describe("Line description"),
      invoiceDescription: z.string().optional().describe("Description shown on the invoice"),
      effectiveDate: z.string().optional().describe("Effective date (ISO 8601)"),
      cancelledDate: z.string().optional().describe("Cancelled date (ISO 8601)"),
      unitPrice: z.number().optional().describe("Unit price"),
      unitCost: z.number().optional().describe("Unit cost"),
      taxableFlag: z.boolean().optional().describe("Whether this addition is taxable"),
      uom: z.string().optional().describe("Unit of measure"),
    },
    async ({
      agreementId,
      productId,
      billCustomer,
      quantity,
      description,
      invoiceDescription,
      effectiveDate,
      cancelledDate,
      unitPrice,
      unitCost,
      taxableFlag,
      uom,
    }) => {
      const body: Record<string, unknown> = {
        product: { id: productId },
        billCustomer,
      };
      if (quantity !== undefined) body.quantity = quantity;
      if (description) body.description = description;
      if (invoiceDescription) body.invoiceDescription = invoiceDescription;
      if (effectiveDate) body.effectiveDate = effectiveDate;
      if (cancelledDate) body.cancelledDate = cancelledDate;
      if (unitPrice !== undefined) body.unitPrice = unitPrice;
      if (unitCost !== undefined) body.unitCost = unitCost;
      if (taxableFlag !== undefined) body.taxableFlag = taxableFlag;
      if (uom) body.uom = uom;

      const result = await client.post(`/finance/agreements/${agreementId}/additions`, body);
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
