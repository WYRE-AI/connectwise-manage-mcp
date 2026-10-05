import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";

// RFC 6902 requires a "value" member on add/replace but forbids relying on it
// for remove. A flat z.object with an optional value let a caller omit it on
// add/replace: applyPatchLocally would silently drop the field (undefined
// isn't serialized), producing a preview that looks fine while the live
// PATCH request goes out missing a member Manage requires. The discriminated
// union makes that combination unrepresentable instead of just undocumented.
//
// z.unknown() alone accepts `undefined` even when not marked .optional() —
// Zod treats an absent key the same as a present key valued `undefined` for
// an unknown/any field, so plain `value: z.unknown()` would NOT actually
// reject a missing value (confirmed by hand: it let `{ op: "replace", path:
// "quantity" }` straight through to the live fetch call, which then crashed
// on a mocked-undefined response instead of failing schema validation). The
// refine makes "present and not undefined" an explicit condition.
const requiredValue = z.unknown().refine((v) => v !== undefined, {
  message: "value is required for add/replace operations (RFC 6902)",
});

const additionPatchOperation = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    path: z.string().describe("Field path (e.g. 'quantity', 'billCustomer', 'cancelledDate')"),
    value: requiredValue.describe("New value"),
  }),
  z.object({
    op: z.literal("replace"),
    path: z.string().describe("Field path (e.g. 'quantity', 'billCustomer', 'cancelledDate')"),
    value: requiredValue.describe("New value"),
  }),
  z.object({
    op: z.literal("remove"),
    path: z.string().describe("Field path (e.g. 'quantity', 'billCustomer', 'cancelledDate')"),
    value: z.unknown().optional().describe("Unused for remove"),
  }),
]);

type AdditionPatchOperation = z.infer<typeof additionPatchOperation>;

/**
 * Manage's invoice resource has no line-item child. The OpenAPI (as generated
 * into the pyconnectwise client) only nests `payments` and `pdf` under
 * `/finance/invoices/{id}`. Product, time, and expense lines that have been
 * billed onto an invoice each carry an `invoice` reference on their own
 * collection, so a spend review filters those collections with
 * `invoice/id = {id}` rather than calling a path that does not exist.
 *
 * Extra caller conditions are ANDed inside parentheses so an `or` in the
 * extra clause cannot escape the invoice scope. The wrapper only holds if the
 * extra clause cannot close it early (`x) or (y`), so parentheses outside
 * double-quoted literals must be balanced and never close before they open.
 */
export function invoiceScopedConditions(invoiceId: number, conditions?: string): string {
  const scoped = `invoice/id = ${invoiceId}`;
  const extra = conditions?.trim();
  if (!extra) return scoped;
  assertGroupedConditions(extra);
  return `${scoped} and (${extra})`;
}

function assertGroupedConditions(conditions: string): void {
  let depth = 0;
  let inQuote = false;
  for (const ch of conditions) {
    if (ch === '"') inQuote = !inQuote;
    else if (inQuote) continue;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) {
      throw new Error("conditions closes a parenthesis it did not open");
    }
  }
  if (inQuote) throw new Error("conditions has an unterminated string literal");
  if (depth !== 0) throw new Error("conditions has unbalanced parentheses");
}

function invoiceLineListArgs() {
  return {
    invoiceId: z.number().describe("Invoice ID"),
    conditions: z
      .string()
      .optional()
      .describe(
        'Extra ConnectWise conditions, ANDed with the invoice scope. String literals use double quotes (e.g. productClass = "Agreement").',
      ),
    page: z.number().optional().describe("Page number (default: 1)"),
    pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    orderBy: z.string().optional().describe("Field to order by"),
  };
}

function invoiceLineQuery(
  invoiceId: number,
  page: number | undefined,
  pageSize: number | undefined,
  orderBy: string | undefined,
  conditions: string | undefined,
): Record<string, string | number | undefined> {
  return {
    conditions: invoiceScopedConditions(invoiceId, conditions),
    page: page ?? 1,
    pageSize: pageSize ?? 25,
    orderBy,
  };
}

/**
 * Applies flat-field JSON Patch operations to a record in memory, matching
 * the same simple-path convention (top-level field names, not nested JSON
 * Pointers) that cw_update_time_entry documents. Used for cw_update_agreement_addition's
 * dryRun mode so a preview never has to round-trip through Manage.
 */
export function applyPatchLocally(
  record: Record<string, unknown>,
  operations: AdditionPatchOperation[],
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
    "Search invoices in ConnectWise Manage. Returns headers and totals only (productTotal, serviceTotal, expenseTotal, agreementAmount), not line items. For a spend review, take each id from here and call cw_get_invoice_products, cw_get_invoice_time_entries, and cw_get_invoice_expenses. Requires Finance → Invoicing → Inquire.",
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
    "Get a specific invoice by ID (GET /finance/invoices/{id}). Returns the header and totals: productTotal, serviceTotal, expenseTotal, agreementAmount, subtotal, and total. Manage does not nest products, time, or expenses on this resource (only payments and a PDF). Line detail is cw_get_invoice_products, cw_get_invoice_time_entries, and cw_get_invoice_expenses. Requires Finance → Invoicing → Inquire.",
    {
      id: z.number().describe("Invoice ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/finance/invoices/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_invoice_products",
    "List procurement product lines charged to an invoice (GET /procurement/products with conditions invoice/id = {invoiceId}). There is no /finance/invoices/{id}/products child. Each ProductItem includes catalogItem, description, quantity, price, cost, billableOption, productClass (Agreement, Bundle, Inventory, NonInventory, or Service), agreement, and agreementAmount. Agreement-related product charges are the lines whose productClass is Agreement or whose agreement / agreementAmount is set — this tool does not roll them up. Page through results (default 25, max 1000); orderBy sequenceNumber matches invoice sequence. Requires Inquire on procurement products, separate from Finance → Invoicing.",
    invoiceLineListArgs(),
    async ({ invoiceId, conditions, page, pageSize, orderBy }) => {
      const result = await client.get(
        "/procurement/products",
        invoiceLineQuery(invoiceId, page, pageSize, orderBy, conditions),
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_invoice_time_entries",
    "List time entries billed on an invoice (GET /time/entries with conditions invoice/id = {invoiceId}). There is no invoice time-entry child. Each entry includes actualHours, hoursBilled, invoiceHours, hourlyRate, billableOption, status (including Billed and BilledAgreement), agreement, agreementAmount, and agreementHours. Agreement-covered time stays on these records; this tool does not merge it into the invoice header. Page through results (default 25, max 1000). Requires Inquire on time entries, separate from Finance → Invoicing.",
    invoiceLineListArgs(),
    async ({ invoiceId, conditions, page, pageSize, orderBy }) => {
      const result = await client.get(
        "/time/entries",
        invoiceLineQuery(invoiceId, page, pageSize, orderBy, conditions),
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_invoice_expenses",
    "List expense entries billed on an invoice (GET /expense/entries with conditions invoice/id = {invoiceId}). There is no invoice expense child. Each entry includes type, amount, billAmount, invoiceAmount, billableOption, status, agreement, and agreementAmount. Compare invoiceAmount to the header expenseTotal from cw_get_invoice; this tool does not recompute that total. Page through results (default 25, max 1000). Requires Inquire on expense entries, separate from Finance → Invoicing.",
    invoiceLineListArgs(),
    async ({ invoiceId, conditions, page, pageSize, orderBy }) => {
      const result = await client.get(
        "/expense/entries",
        invoiceLineQuery(invoiceId, page, pageSize, orderBy, conditions),
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
