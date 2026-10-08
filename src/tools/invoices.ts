/**
 * cw_update_invoice: JSON Patch updates to a finance invoice
 * (Manage PATCH /finance/invoices/{id}), with a path allow-list, a dryRun
 * preview mode, and a single retry on 429/5xx.
 *
 * Registered from registerAgreementTools right after cw_search_invoices /
 * cw_get_invoice so the three invoice tools stay together in tools/list.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwApiError, CwManageClient } from "../api-client.js";

/** Normalized (no leading slash) JSON Patch paths cw_update_invoice accepts in v1. */
export const INVOICE_ALLOWED_PATHS: readonly string[] = [
  "status",
  "status/id",
  "attention",
  "dueDate",
  "date",
  "reference",
  "customerPO",
  "internalNotes",
  "billToCompany",
  "billToCompany/id",
  "billingSite",
  "billingSite/id",
  // Accepted as an alias: Manage's invoice model names this field billingSite.
  "billToSite",
  "billToSite/id",
];

/**
 * Friendly aliases rewritten to the real Manage invoice field before the
 * PATCH goes out (verified against a live Scout invoice: the object carries
 * billingSite, not billToSite).
 */
const INVOICE_PATH_ALIASES: Record<string, string> = {
  billToSite: "billingSite",
  "billToSite/id": "billingSite/id",
};

/**
 * Paths callers commonly try that do not exist on a Manage invoice, with a
 * pointer to what to use instead.
 */
const INVOICE_UNSUPPORTED_HINTS: Record<string, string> = {
  billToContact:
    "Manage invoices have no billToContact field (that exists on agreements/opportunities). Set the contact name via 'attention', or change the bill-to company/site.",
  "billToContact/id":
    "Manage invoices have no billToContact field (that exists on agreements/opportunities). Set the contact name via 'attention', or change the bill-to company/site.",
};

/** Paths that must always carry a value — removing them would leave the invoice invalid. */
const INVOICE_NON_REMOVABLE_PATHS = new Set([
  "status",
  "status/id",
  "date",
  "billToCompany",
  "billToCompany/id",
]);

/** Reference fields: whole-object replace must be `{ id: <number> }`. */
const INVOICE_REFERENCE_PATHS = new Set(["status", "billToCompany", "billingSite"]);

const requiredValue = z.unknown().refine((v) => v !== undefined, {
  message: "value is required for add/replace operations (RFC 6902)",
});

const pathDescription =
  "Invoice field path, with or without a leading slash. Allowed: status/id, status ({id}), attention, dueDate, date, reference, customerPO, internalNotes, billToCompany[/id], billingSite[/id] (alias billToSite[/id]).";

const invoicePatchOperation = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("replace"),
    path: z.string().describe(pathDescription),
    value: requiredValue.describe("New value (status/id: numeric billing status id; status: { id })"),
  }),
  z.object({
    op: z.literal("add"),
    path: z.string().describe(pathDescription),
    value: requiredValue.describe("New value"),
  }),
  z.object({
    op: z.literal("remove"),
    path: z.string().describe(pathDescription),
    value: z.unknown().optional().describe("Unused for remove"),
  }),
]);

export type InvoicePatchOperation = z.infer<typeof invoicePatchOperation>;

/** Strip one leading slash and resolve aliases: "/billToSite/id" -> "billingSite/id". */
export function normalizeInvoicePath(path: string): string {
  const stripped = path.trim().replace(/^\//, "");
  return INVOICE_PATH_ALIASES[stripped] ?? stripped;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Validates operations against the v1 allow-list and returns them with
 * normalized paths. Throws (before any Manage call) on the first problem,
 * listing every offending operation so the caller can fix them in one pass.
 */
export function validateInvoiceOperations(operations: InvoicePatchOperation[]): InvoicePatchOperation[] {
  if (operations.length === 0) {
    throw new Error("operations must contain at least one JSON Patch operation");
  }
  const errors: string[] = [];
  const normalized = operations.map((operation, i) => {
    const path = normalizeInvoicePath(operation.path);
    const where = `operations[${i}] (${operation.op} ${operation.path})`;
    if (INVOICE_UNSUPPORTED_HINTS[path]) {
      errors.push(`${where}: ${INVOICE_UNSUPPORTED_HINTS[path]}`);
      return { ...operation, path };
    }
    if (!INVOICE_ALLOWED_PATHS.includes(path)) {
      errors.push(
        `${where}: path '${path}' is not allowed. cw_update_invoice v1 only accepts: ${INVOICE_ALLOWED_PATHS.join(", ")}. Custom fields and payment fields are not supported.`,
      );
      return { ...operation, path };
    }
    if (operation.op === "remove") {
      if (INVOICE_NON_REMOVABLE_PATHS.has(path)) {
        errors.push(`${where}: '${path}' cannot be removed; use replace instead.`);
      }
      return { ...operation, path };
    }
    const value = operation.value;
    if (path.endsWith("/id") && !isPositiveInt(value)) {
      errors.push(`${where}: value must be a positive integer id, got ${JSON.stringify(value)}.`);
    }
    if (INVOICE_REFERENCE_PATHS.has(path)) {
      const id = (value as { id?: unknown } | null)?.id;
      if (typeof value !== "object" || value === null || Array.isArray(value) || !isPositiveInt(id)) {
        errors.push(`${where}: value must be an object like { "id": 7 }, got ${JSON.stringify(value)}.`);
      }
    }
    return { ...operation, path };
  });
  if (errors.length > 0) {
    throw new Error(`cw_update_invoice rejected the patch before calling Manage:\n- ${errors.join("\n- ")}`);
  }
  return normalized;
}

/**
 * Applies validated (normalized-path) operations to an invoice in memory for
 * dryRun. Unlike agreements.ts applyPatchLocally this understands one level of
 * nesting ("status/id"), since invoice reference fields are objects. The input
 * is not mutated. Note: replacing status/id leaves status.name as the old
 * name in the preview — Manage resolves the name on a real save.
 */
export function applyInvoicePatchLocally(
  record: Record<string, unknown>,
  operations: InvoicePatchOperation[],
): Record<string, unknown> {
  const patched = structuredClone(record);
  for (const { op, path, value } of operations) {
    const segments = normalizeInvoicePath(path).split("/");
    let target: Record<string, unknown> = patched;
    for (const segment of segments.slice(0, -1)) {
      const next = target[segment];
      if (typeof next !== "object" || next === null) {
        target[segment] = {};
      }
      target = target[segment] as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1];
    if (op === "remove") {
      delete target[leaf];
    } else {
      target[leaf] = structuredClone(value);
    }
  }
  return patched;
}

/** HTTP statuses retried once: rate limiting and server errors. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Runs `fn`; if it fails with a CwApiError whose status is 429 or 5xx, waits
 * `backoffMs` and tries exactly once more. Any other error (including every
 * other 4xx) propagates immediately. CwManageClient itself never retries, so
 * this is the only retry layer.
 */
export async function withSingleRetry<T>(fn: () => Promise<T>, backoffMs = 1000): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CwApiError && isRetryableStatus(err.status)) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return fn();
    }
    throw err;
  }
}

function errorResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

const DESCRIPTION = [
  "Update a single finance invoice with JSON Patch (Manage PATCH /finance/invoices/{id}); returns the updated invoice (same shape as cw_get_invoice).",
  "Allowed paths (with or without leading slash): status/id (numeric id) or status ({ id }); attention, dueDate, date, reference, customerPO, internalNotes; billToCompany and billingSite (as { id }) or their /id subpaths (billToSite is accepted as an alias for billingSite). Manage invoices have no billToContact field; use attention for the contact name. Any other path (custom fields, payment fields, etc.) is rejected before Manage is called.",
  "Scout billing status ids: New = 1, Closed = 6, Approved = 7, Rejected = 8 (inactive), Ready to Send = 11. Callers must resolve a status name to one of these ids first and never invent or guess an id; if the name does not match, stop and ask.",
  "No batch mode: one invoice per call. To update many, loop over ids with concurrency 3-5 and report the result per invoice.",
  "Set dryRun to GET the current invoice, apply the patch locally, and return { dryRun: true, saved: false, preview } with no write.",
  "Errors from Manage (400/401/403/404/409) are returned with Manage's message; 429/5xx is retried once after a short backoff. Requires the API member's security role to have Finance > Invoices: Edit.",
].join(" ");

export function registerInvoiceUpdateTool(server: McpServer, client: CwManageClient, backoffMs = 1000) {
  server.tool(
    "cw_update_invoice",
    DESCRIPTION,
    {
      id: z.number().int().positive().describe("Invoice ID"),
      operations: z
        .array(invoicePatchOperation)
        .min(1)
        .describe("JSON Patch operations, e.g. [{ op: 'replace', path: 'status/id', value: 11 }]"),
      dryRun: z
        .boolean()
        .optional()
        .describe("If true, fetch the current invoice, apply the patch locally, and return the would-be result without calling PATCH (no write is made)."),
    },
    async ({ id, operations, dryRun }) => {
      let normalized: InvoicePatchOperation[];
      try {
        normalized = validateInvoiceOperations(operations);
      } catch (err) {
        return errorResult(err);
      }
      const path = `/finance/invoices/${id}`;
      try {
        if (dryRun) {
          const current = await withSingleRetry(() => client.get<Record<string, unknown>>(path), backoffMs);
          const preview = applyInvoicePatchLocally(current, normalized);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ dryRun: true, saved: false, operations: normalized, preview }, null, 2),
              },
            ],
          };
        }
        const result = await withSingleRetry(() => client.patch(path, normalized), backoffMs);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
