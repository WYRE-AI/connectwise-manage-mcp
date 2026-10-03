import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";

/**
 * Procurement inventory tools (ConnectWise Procurement API).
 *
 * Covers the warehouse structure (warehouses and their bins), the on-hand
 * stock held in each bin, and Inventory Adjustments, which are the only
 * supported way to change on-hand quantities through the API.
 *
 * An adjustment is a two-part record. The header (POST /procurement/adjustments)
 * carries the identifier, type and reason. Each line
 * (POST /procurement/adjustments/{parentId}/details) names a catalog item, a
 * warehouse bin and a signed quantityAdjusted. Nothing moves until the header
 * is closed with closedFlag = true, and a closed adjustment cannot be reopened
 * or deleted, so the posting is reversed only by a counter-adjustment.
 *
 * Field names below are taken from the ConnectWise Manage OpenAPI spec
 * (ProcurementAdjustment, AdjustmentDetail, AdjustmentType, Warehouse,
 * WarehouseBin and InventoryOnHand). Two gaps in that spec are worth knowing:
 *
 * 1. ProcurementAdjustment has no "summary" field. The free-text fields are
 *    reason (max 100 characters) and notes (unbounded).
 * 2. Nothing in the spec exposes an average cost. InventoryOnHand carries only
 *    catalogItem, warehouse, warehouseBin, onHand and serialNumbers. The unit
 *    cost reported by cw_get_inventory_on_hand is therefore the catalog item's
 *    own cost field, which is the standing cost rather than the weighted
 *    average cost that ConnectWise itself holds against the inventory.
 */

/** ConnectWise caps pageSize at 1000 on every paged endpoint. */
const MAX_PAGE_SIZE = 1000;

/** Bins are scanned concurrently, kept low so a wide scan does not trip API rate limits. */
const BIN_SCAN_CONCURRENCY = 4;

/** Catalog item lookups are chunked so the conditions string stays a sane length. */
const CATALOG_LOOKUP_CHUNK = 100;

interface Reference {
  id?: number | null;
  identifier?: string;
  name?: string;
}

interface WarehouseBinRecord {
  id?: number;
  name?: string;
  warehouse?: Reference;
  inactiveFlag?: boolean | null;
}

interface SerialNumberRecord {
  id?: number | null;
  serialNumber?: string;
}

interface InventoryOnHandRecord {
  id?: number;
  catalogItem?: Reference;
  warehouse?: Reference;
  warehouseBin?: Reference;
  onHand?: number | null;
  serialNumbers?: SerialNumberRecord[];
}

interface CatalogItemRecord {
  id?: number;
  identifier?: string;
  description?: string;
  cost?: number | null;
  serializedFlag?: boolean | null;
}

/**
 * Read every page of a ConnectWise collection endpoint.
 *
 * ConnectWise returns a bare array and no total count, so the only reliable
 * stop condition is a short page. maxPages guards against an endpoint that
 * ignores paging and hands back the same page forever. Hitting it throws
 * rather than returning a truncated list, because callers total the rows and
 * a silent partial result would give wrong totals.
 */
async function fetchAllPages<T>(
  client: CwManageClient,
  path: string,
  params: Record<string, string | number | undefined> = {},
  maxPages = 100,
): Promise<T[]> {
  const pageSize = MAX_PAGE_SIZE;
  const all: T[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const batch = await client.get<T[]>(path, { ...params, page, pageSize });
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < pageSize) break;
    if (page === maxPages) {
      throw new Error(
        `Pagination limit of ${maxPages} pages reached before ${path} ended. Narrow the request rather than accept a partial result.`,
      );
    }
  }

  return all;
}

/** Run an async mapper over items, at most `limit` in flight at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (let index = cursor++; index < items.length; index = cursor++) {
        results[index] = await mapper(items[index]);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

/** Combine a caller-supplied conditions string with a filter this tool adds itself. */
function andConditions(...parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter((p): p is string => Boolean(p && p.trim()));
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0];
  return kept.map((p) => `(${p})`).join(" and ");
}

/** Round to cents so accumulated floating point noise does not reach the caller. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function registerProcurementTools(server: McpServer, client: CwManageClient) {
  // -------------------------------------------------------------------------
  // Warehouse structure
  // -------------------------------------------------------------------------

  server.tool(
    "cw_list_warehouses",
    "List inventory warehouses in ConnectWise Manage. A warehouse groups the bins that actually hold stock, so start here before reading on-hand quantities or building an adjustment. Each warehouse carries name, location, department, currency and the inactiveFlag / lockedFlag pair: a locked warehouse rejects adjustments.",
    {
      conditions: z
        .string()
        .optional()
        .describe(
          "ConnectWise conditions query string (e.g. \"inactiveFlag = false\" or \"name like '%Perth%'\")",
        ),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z
        .number()
        .optional()
        .describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by (e.g. 'name asc')"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/procurement/warehouses", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_list_warehouse_bins",
    "List warehouse bins in ConnectWise Manage. A bin is the location stock actually sits in, and every inventory adjustment line names one. Pass warehouseId to list only the bins of a single warehouse. The quantityOnHand on a bin is a rollup across every item in it, so use cw_get_inventory_on_hand for per-item stock.",
    {
      warehouseId: z
        .number()
        .optional()
        .describe("Only return bins belonging to this warehouse ID"),
      conditions: z
        .string()
        .optional()
        .describe(
          "ConnectWise conditions query string (e.g. \"inactiveFlag = false\"). Combined with warehouseId when both are given",
        ),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z
        .number()
        .optional()
        .describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by (e.g. 'name asc')"),
    },
    async ({ warehouseId, conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/procurement/warehouseBins", {
        conditions: andConditions(
          conditions,
          warehouseId !== undefined ? `warehouse/id = ${warehouseId}` : undefined,
        ),
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // -------------------------------------------------------------------------
  // On-hand stock
  // -------------------------------------------------------------------------

  server.tool(
    "cw_get_inventory_on_hand",
    "Report every catalog item holding non-zero stock, one row per warehouse bin. Negative on-hand is reported too, because a negative balance is exactly what an adjustment usually has to correct. ConnectWise exposes on-hand only per bin, so this walks every bin and pages each one fully, which makes a whole-instance scan slow: pass warehouseId or binIds to narrow it. Each row gives the catalog item ID, identifier and description, the warehouse and bin, the on-hand quantity, the unit cost and the extended value, plus any serial numbers held in that bin. Read the cost with care: the ConnectWise API exposes no average cost field anywhere, so unitCost here is the catalog item's own cost field, which is the standing cost and not the weighted average cost ConnectWise values the stock at.",
    {
      warehouseId: z
        .number()
        .optional()
        .describe(
          "Only scan bins in this warehouse ID. Strongly recommended: scanning every bin in the instance can take a long time",
        ),
      binIds: z
        .array(z.number())
        .optional()
        .describe(
          "Only scan these specific warehouse bin IDs. Takes precedence over warehouseId",
        ),
      catalogItemId: z
        .number()
        .optional()
        .describe("Only report rows for this catalog item ID"),
      includeInactiveBins: z
        .boolean()
        .optional()
        .describe(
          "Include bins flagged inactive (default: false). An inactive bin can still hold stock",
        ),
      includeSerialNumbers: z
        .boolean()
        .optional()
        .describe(
          "Include the serial numbers held in each bin for serialised items (default: true)",
        ),
      includeCosts: z
        .boolean()
        .optional()
        .describe(
          "Look up catalog item cost and description to compute extended value (default: true). Set false to skip the extra catalog calls",
        ),
    },
    async ({
      warehouseId,
      binIds,
      catalogItemId,
      includeInactiveBins,
      includeSerialNumbers,
      includeCosts,
    }) => {
      const withSerials = includeSerialNumbers ?? true;
      const withCosts = includeCosts ?? true;

      // 1. Work out which bins to scan.
      const binConditions =
        binIds && binIds.length > 0
          ? `id in (${binIds.join(",")})`
          : andConditions(
              warehouseId !== undefined ? `warehouse/id = ${warehouseId}` : undefined,
              includeInactiveBins ? undefined : "inactiveFlag = false",
            );

      const bins = await fetchAllPages<WarehouseBinRecord>(
        client,
        "/procurement/warehouseBins",
        { conditions: binConditions },
      );

      const scannable = bins.filter((bin) => typeof bin.id === "number");

      // 2. Page every bin's on-hand list.
      const perBin = await mapWithConcurrency(
        scannable,
        BIN_SCAN_CONCURRENCY,
        async (bin) =>
          fetchAllPages<InventoryOnHandRecord>(
            client,
            `/procurement/warehouseBins/${bin.id}/inventoryOnHand`,
            catalogItemId !== undefined
              ? { conditions: `catalogItem/id = ${catalogItemId}` }
              : {},
          ),
      );

      // 3. Keep only non-zero balances, negatives included.
      const onHandRows = perBin
        .flat()
        .filter((row) => typeof row.onHand === "number" && row.onHand !== 0);

      // 4. Enrich with catalog cost and description. The InventoryOnHand
      //    catalogItem reference carries identifier and name but no cost, so
      //    the items are looked up in chunks.
      const catalogById = new Map<number, CatalogItemRecord>();
      if (withCosts) {
        const ids = [
          ...new Set(
            onHandRows
              .map((row) => row.catalogItem?.id)
              .filter((id): id is number => typeof id === "number"),
          ),
        ];

        for (let i = 0; i < ids.length; i += CATALOG_LOOKUP_CHUNK) {
          const chunk = ids.slice(i, i + CATALOG_LOOKUP_CHUNK);
          const items = await fetchAllPages<CatalogItemRecord>(
            client,
            "/procurement/catalog",
            { conditions: `id in (${chunk.join(",")})` },
          );
          for (const item of items) {
            if (typeof item.id === "number") catalogById.set(item.id, item);
          }
        }
      }

      const rows = onHandRows.map((row) => {
        const itemId = row.catalogItem?.id ?? null;
        const item = typeof itemId === "number" ? catalogById.get(itemId) : undefined;
        const onHand = row.onHand as number;
        const unitCost = item?.cost ?? null;
        const serials = (row.serialNumbers ?? [])
          .map((s) => s.serialNumber)
          .filter((s): s is string => Boolean(s));

        return {
          catalogItemId: itemId,
          identifier: row.catalogItem?.identifier ?? item?.identifier ?? null,
          description: item?.description ?? row.catalogItem?.name ?? null,
          warehouseId: row.warehouse?.id ?? null,
          warehouse: row.warehouse?.name ?? null,
          warehouseBinId: row.warehouseBin?.id ?? null,
          warehouseBin: row.warehouseBin?.name ?? null,
          onHand,
          unitCost,
          extendedValue:
            typeof unitCost === "number" ? round2(unitCost * onHand) : null,
          serialised: item?.serializedFlag ?? null,
          serialNumberCount: serials.length,
          ...(withSerials && serials.length > 0 ? { serialNumbers: serials } : {}),
        };
      });

      const valued = rows.filter((r) => typeof r.extendedValue === "number");
      const totalValue = round2(
        valued.reduce((sum, r) => sum + (r.extendedValue as number), 0),
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                summary: {
                  binsScanned: scannable.length,
                  binsWithStock: new Set(rows.map((r) => r.warehouseBinId)).size,
                  rowCount: rows.length,
                  negativeRowCount: rows.filter((r) => r.onHand < 0).length,
                  distinctCatalogItems: new Set(rows.map((r) => r.catalogItemId)).size,
                  totalOnHandUnits: rows.reduce((sum, r) => sum + r.onHand, 0),
                  totalExtendedValue: totalValue,
                  rowsMissingCost: rows.length - valued.length,
                  valueBasis: withCosts
                    ? "Catalog item cost field, in the ConnectWise instance currency. The API exposes no average cost, so this is the standing cost and not the weighted average cost ConnectWise values the stock at."
                    : "Costs not requested, so no value was computed.",
                },
                rows,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Adjustments
  // -------------------------------------------------------------------------

  server.tool(
    "cw_list_adjustment_types",
    "List inventory adjustment types in ConnectWise Manage. Every adjustment header names one, so call this before creating an adjustment. Each type carries an identifier, a name and an auditTrailFlag. The type is what tells ConnectWise which general ledger account the adjustment posts against, so pick it deliberately rather than taking the first row.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z
        .number()
        .optional()
        .describe("Results per page (default: 25, max: 1000)"),
      orderBy: z
        .string()
        .optional()
        .describe("Field to order by (e.g. 'identifier asc')"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/procurement/adjustments/types", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_create_adjustment",
    "Create an inventory adjustment header in ConnectWise Manage and return its ID. This writes the header only and moves no stock: add lines with cw_add_adjustment_detail, then post it with cw_close_adjustment. An open adjustment has no effect on on-hand quantities, so it is safe to leave one open and delete it in ConnectWise if the plan changes. ConnectWise has no 'summary' field on an adjustment: the free-text fields are reason (max 100 characters, which is what shows in the adjustment list) and notes (unbounded).",
    {
      identifier: z
        .string()
        .max(50)
        .describe("Adjustment identifier, unique within the instance (max 50 characters)"),
      typeId: z
        .number()
        .describe(
          "Adjustment type ID from cw_list_adjustment_types. Required by ConnectWise",
        ),
      reason: z
        .string()
        .max(100)
        .optional()
        .describe(
          "Short reason for the adjustment (max 100 characters). This is the field shown in the ConnectWise adjustment list",
        ),
      notes: z
        .string()
        .optional()
        .describe(
          "Free-text notes on the adjustment. Use this for the fuller explanation that will not fit in reason",
        ),
    },
    async ({ identifier, typeId, reason, notes }) => {
      const body: Record<string, unknown> = {
        identifier,
        type: { id: typeId },
      };
      if (reason) body.reason = reason;
      if (notes) body.notes = notes;

      const result = await client.post<{ id?: number }>(
        "/procurement/adjustments",
        body,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ id: result?.id ?? null, adjustment: result }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "cw_add_adjustment_detail",
    "Add one line to an open inventory adjustment. quantityAdjusted is signed and applied to the current on-hand, so pass a negative number to remove stock: zeroing a bin holding 7 units means quantityAdjusted = -7. ConnectWise takes whole units only on this field. Both warehouseId and warehouseBinId are required by the API, not just the bin. Adding a line still moves no stock: nothing posts until cw_close_adjustment. For a serialised item, pass the exact serial numbers being adjusted in serialNumbers; ConnectWise stores them as one comma-joined string capped at 1000 characters, and a negative adjustment on a serialised item is generally rejected without them, so read them off cw_get_inventory_on_hand first. Leave unitCost unset to let ConnectWise apply its own average cost, which is the safer default because the API cannot report that cost for you to match.",
    {
      adjustmentId: z
        .number()
        .describe(
          "ID of the adjustment header to add the line to, from cw_create_adjustment",
        ),
      catalogItemId: z.number().describe("Catalog item ID being adjusted"),
      warehouseId: z
        .number()
        .describe("Warehouse ID holding the stock. Required by ConnectWise alongside the bin"),
      warehouseBinId: z.number().describe("Warehouse bin ID holding the stock"),
      quantityAdjusted: z
        .number()
        .int()
        .describe(
          "Signed whole-unit change to on-hand. Negative removes stock (e.g. -7 zeroes a bin holding 7), positive adds it",
        ),
      unitCost: z
        .number()
        .optional()
        .describe(
          "Unit cost for the line. Omit to let ConnectWise apply its own average cost, which is usually what you want for a stock write-off",
        ),
      description: z
        .string()
        .max(50)
        .optional()
        .describe(
          "Line description (max 50 characters). Defaults to the catalog item description",
        ),
      serialNumbers: z
        .array(z.string())
        .optional()
        .describe(
          "Serial numbers being adjusted, for serialised items. Joined with commas into the single serialNumber field ConnectWise provides, which caps at 1000 characters",
        ),
    },
    async ({
      adjustmentId,
      catalogItemId,
      warehouseId,
      warehouseBinId,
      quantityAdjusted,
      unitCost,
      description,
      serialNumbers,
    }) => {
      const body: Record<string, unknown> = {
        catalogItem: { id: catalogItemId },
        warehouse: { id: warehouseId },
        warehouseBin: { id: warehouseBinId },
        quantityAdjusted,
      };
      if (unitCost !== undefined) body.unitCost = unitCost;
      if (description) body.description = description;

      if (serialNumbers && serialNumbers.length > 0) {
        const joined = serialNumbers.join(",");
        if (joined.length > 1000) {
          throw new Error(
            `serialNumbers joins to ${joined.length} characters, over the 1000 character limit ConnectWise allows on the serialNumber field. Split the adjustment across several lines.`,
          );
        }
        body.serialNumber = joined;
      }

      const result = await client.post(
        `/procurement/adjustments/${adjustmentId}/details`,
        body,
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_adjustment",
    "Get an inventory adjustment header together with every one of its detail lines. Use this to check an adjustment before posting it with cw_close_adjustment, and to read back the unitCost ConnectWise applied to each line. The header's closedFlag tells you whether it has already posted.",
    {
      id: z.number().describe("Adjustment ID"),
    },
    async ({ id }) => {
      const adjustment = await client.get<Record<string, unknown>>(
        `/procurement/adjustments/${id}`,
      );
      const details = await fetchAllPages<Record<string, unknown>>(
        client,
        `/procurement/adjustments/${id}/details`,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                adjustment,
                detailCount: details.length,
                details,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "cw_close_adjustment",
    "Post an inventory adjustment by setting closedFlag to true. THIS IS THE WRITE THAT MOVES STOCK: closing the adjustment applies every detail line to on-hand quantities and writes the matching general ledger entries. It is not reversible except by a counter-adjustment. ConnectWise will not let a closed adjustment be reopened, edited or deleted, so the only way back is a second adjustment posting the opposite quantities. Call cw_get_adjustment and check every line first, and confirm with the user before calling this.",
    {
      id: z.number().describe("Adjustment ID to close and post"),
    },
    async ({ id }) => {
      const result = await client.patch(`/procurement/adjustments/${id}`, [
        { op: "replace", path: "closedFlag", value: true },
      ]);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
