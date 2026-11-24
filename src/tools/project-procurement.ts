import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import { fetchAllPages, mapWithConcurrency } from "./procurement.js";

/**
 * Project and ticket procurement status tools (ConnectWise Procurement API).
 *
 * These answer the question an MSP asks about a job: "for this project (or
 * ticket), which products are in stock and which are still awaiting
 * arrival?" ConnectWise spreads that answer across several records:
 *
 * - Product items (GET /procurement/products) are the catalog SKUs placed on
 *   the project or ticket, with quantity, cancellation, needToPurchaseFlag and
 *   poApprovedFlag. Needs Procurement > Products.
 * - Picking and shipping details (GET /procurement/products/{id}/
 *   pickingShippingDetails) hold the quantity picked (allocated from stock,
 *   which is where a received purchase order line lands for a product placed
 *   on a ticket or project) and shipped. Needs Procurement > Products.
 * - Purchase order line items (GET /procurement/purchaseorders/{id}/lineitems)
 *   hold the receipt: receivedQuantity, receivedStatus (Waiting,
 *   FullyReceived, PartiallyReceiveCancelRest, PartiallyReceiveCloneRest),
 *   dateReceived and the vendor shipping fields. Needs Procurement > Purchase
 *   Orders.
 * - Catalog item inventory (GET /procurement/catalog/{id}/inventory) holds the
 *   on-hand stock per warehouse bin. Needs only Procurement > Product Catalog,
 *   unlike the warehouse bin walk, which needs System > Table Setup.
 *
 * The public API gives a purchase order line no ticket or project reference
 * (PurchaseOrderLineItem carries product, salesOrder[], warehouse and bin,
 * nothing else). So a line is tied to a project product by the strongest key
 * available, and every match says which one it used:
 *   1. "salesOrder": the line lists the product item's sales order.
 *   2. "customerCompanyAndCatalogItem": the purchase order's customer company
 *      is the product item's company and the line is for the same catalog
 *      item. This is a strong hint, not a hard link: two open jobs for the
 *      same customer that order the same SKU will both match.
 *
 * Every tool here is read-only.
 */

/** Product items are read at most this many pages of 1000. */
const PRODUCT_MAX_PAGES = 10;
/** Purchase orders scanned for line matches, at most. */
const PO_SCAN_LIMIT = 200;
/** Concurrent requests for per-product and per-PO child reads. */
const CHILD_CONCURRENCY = 4;
/** Default purchase order look-back when matching receipts. */
const DEFAULT_PO_LOOKBACK_DAYS = 365;

interface Ref {
  id?: number | null;
  identifier?: string;
  name?: string;
}

export interface ProductItemRecord {
  id?: number;
  catalogItem?: Ref;
  description?: string;
  quantity?: number | null;
  quantityCancelled?: number | null;
  cancelledFlag?: boolean | null;
  productClass?: string | null;
  needToPurchaseFlag?: boolean | null;
  needToOrderQuantity?: number | null;
  poApprovedFlag?: boolean | null;
  dropshipFlag?: boolean | null;
  specialOrderFlag?: boolean | null;
  purchaseDate?: string;
  ticket?: Ref;
  project?: Ref;
  phase?: Ref;
  salesOrder?: Ref;
  company?: Ref;
  warehouse?: string;
  warehouseBin?: string;
}

interface PickingShippingRecord {
  pickedQuantity?: number | null;
  shippedQuantity?: number | null;
  warehouse?: Ref;
  warehouseBin?: Ref;
  expectedArrivalDate?: string;
  shipmentDate?: string;
  trackingNumber?: string;
}

interface PurchaseOrderRecord {
  id?: number;
  poNumber?: string;
  poDate?: string;
  closedFlag?: boolean | null;
  status?: Ref;
  vendorCompany?: Ref;
  customerCompany?: Ref;
}

interface PurchaseOrderLineRecord {
  id?: number;
  lineNumber?: number | null;
  description?: string;
  product?: Ref;
  quantity?: number | null;
  receivedQuantity?: number | null;
  receivedStatus?: string | null;
  dateReceived?: string;
  canceledFlag?: boolean | null;
  closedFlag?: boolean | null;
  backorderedFlag?: boolean | null;
  expectedShipDate?: string;
  expectedArrivalDate?: string;
  shipDate?: string;
  trackingNumber?: string;
  warehouse?: Ref;
  warehouseBin?: Ref;
  salesOrder?: Ref[];
}

interface CatalogInventoryRecord {
  catalogItem?: Ref;
  warehouse?: Ref;
  warehouseBin?: Ref;
  onHand?: number | null;
  serialNumbers?: Array<{ serialNumber?: string }>;
}

export type ProductStockStatus =
  | "cancelled"
  | "not_stocked"
  | "shipped"
  | "in_stock"
  | "partially_received"
  | "awaiting_arrival"
  | "awaiting_pick"
  | "not_ordered";

/** A matched purchase order line, flattened for the caller. */
export interface MatchedPoLine {
  purchaseOrderId: number | null;
  poNumber: string | null;
  poStatus: string | null;
  vendor: string | null;
  lineId: number | null;
  catalogItemId: number | null;
  quantity: number;
  receivedQuantity: number;
  outstandingQuantity: number;
  receivedStatus: string | null;
  dateReceived: string | null;
  expectedShipDate: string | null;
  expectedArrivalDate: string | null;
  trackingNumber: string | null;
  canceled: boolean;
  warehouse: string | null;
  warehouseBin: string | null;
  /** Sales order IDs the PO line lists. */
  salesOrderIds: number[];
  matchedBy: "salesOrder" | "customerCompanyAndCatalogItem";
}

const NOT_STOCKED_CLASSES = new Set(["Service", "Agreement"]);

const num = (v: number | null | undefined): number => (typeof v === "number" ? v : 0);

/** Quote a value for a ConnectWise conditions string. */
export function cwQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** ConnectWise date literal for a conditions string. */
function cwDate(date: Date): string {
  return `[${date.toISOString().slice(0, 19)}Z]`;
}

/**
 * Classify one product item's stock position.
 *
 * picked is the quantity allocated to the product from stock, which is
 * where a received purchase order line lands for a product placed on a
 * ticket or project. poLines, when given, decide between "awaiting_arrival"
 * (a purchase order exists or was approved) and "not_ordered".
 */
export function classifyProduct(
  product: ProductItemRecord,
  picked: number,
  shipped: number,
  poLines: MatchedPoLine[] | undefined,
): { status: ProductStockStatus; orderedQuantity: number; awaitingQuantity: number } {
  const ordered = Math.max(0, num(product.quantity) - num(product.quantityCancelled));
  const awaiting = Math.max(0, ordered - Math.max(picked, shipped));

  if (product.cancelledFlag && ordered === 0) {
    return { status: "cancelled", orderedQuantity: 0, awaitingQuantity: 0 };
  }
  if (product.productClass && NOT_STOCKED_CLASSES.has(product.productClass)) {
    return { status: "not_stocked", orderedQuantity: ordered, awaitingQuantity: 0 };
  }
  if (ordered > 0 && shipped >= ordered) {
    return { status: "shipped", orderedQuantity: ordered, awaitingQuantity: 0 };
  }
  if (ordered > 0 && picked >= ordered) {
    return { status: "in_stock", orderedQuantity: ordered, awaitingQuantity: 0 };
  }
  if (picked > 0 || shipped > 0) {
    return { status: "partially_received", orderedQuantity: ordered, awaitingQuantity: awaiting };
  }
  const onOrder =
    Boolean(product.poApprovedFlag) ||
    (poLines ?? []).some((l) => !l.canceled && l.outstandingQuantity > 0);
  const received = (poLines ?? []).some((l) => l.receivedQuantity > 0);
  if (received) {
    // Received on the PO but not yet picked to this product.
    return { status: "partially_received", orderedQuantity: ordered, awaitingQuantity: awaiting };
  }
  let status: ProductStockStatus;
  if (onOrder) status = "awaiting_arrival";
  else if (product.needToPurchaseFlag) status = "not_ordered";
  else status = "awaiting_pick"; // to be filled from existing stock, not yet picked
  return { status, orderedQuantity: ordered, awaitingQuantity: awaiting };
}

function flattenLine(
  po: PurchaseOrderRecord,
  line: PurchaseOrderLineRecord,
  matchedBy: MatchedPoLine["matchedBy"],
): MatchedPoLine {
  const quantity = num(line.quantity);
  const receivedQuantity = num(line.receivedQuantity);
  const canceled = Boolean(line.canceledFlag);
  return {
    purchaseOrderId: po.id ?? null,
    poNumber: po.poNumber ?? null,
    poStatus: po.status?.name ?? null,
    vendor: po.vendorCompany?.name ?? null,
    lineId: line.id ?? null,
    catalogItemId: line.product?.id ?? null,
    quantity,
    receivedQuantity,
    outstandingQuantity: canceled ? 0 : Math.max(0, quantity - receivedQuantity),
    receivedStatus: line.receivedStatus ?? null,
    dateReceived: line.dateReceived ?? null,
    expectedShipDate: line.expectedShipDate ?? null,
    expectedArrivalDate: line.expectedArrivalDate ?? null,
    trackingNumber: line.trackingNumber ?? null,
    canceled,
    warehouse: line.warehouse?.name ?? null,
    warehouseBin: line.warehouseBin?.name ?? null,
    salesOrderIds: (line.salesOrder ?? [])
      .map((so) => so.id)
      .filter((id): id is number => typeof id === "number"),
    matchedBy,
  };
}

/**
 * A copy of a matched line as seen from one product: matchedBy is
 * "salesOrder" only when the line lists that product's own sales order.
 * The shared line record is not changed.
 */
export function lineForProduct(line: MatchedPoLine, product: ProductItemRecord): MatchedPoLine {
  const soId = product.salesOrder?.id;
  const bySalesOrder = typeof soId === "number" && line.salesOrderIds.includes(soId);
  return { ...line, matchedBy: bySalesOrder ? "salesOrder" : "customerCompanyAndCatalogItem" };
}

/** Scope a product search to a project or a ticket. */
function scopeConditions(projectId?: number, ticketId?: number, includeCancelled?: boolean): string {
  const parts: string[] = [];
  if (projectId !== undefined) parts.push(`project/id = ${projectId}`);
  if (ticketId !== undefined) parts.push(`ticket/id = ${ticketId}`);
  if (!includeCancelled) parts.push("cancelledFlag = false");
  return parts.join(" and ");
}

async function loadProducts(
  client: CwManageClient,
  projectId: number | undefined,
  ticketId: number | undefined,
  includeCancelled: boolean,
): Promise<ProductItemRecord[]> {
  return fetchAllPages<ProductItemRecord>(
    client,
    "/procurement/products",
    { conditions: scopeConditions(projectId, ticketId, includeCancelled) },
    PRODUCT_MAX_PAGES,
  );
}

/**
 * Find purchase order lines for the given products' catalog items, on
 * purchase orders for the products' customer companies.
 */
export async function matchPurchaseOrderLines(
  client: CwManageClient,
  products: ProductItemRecord[],
  lookbackDays: number,
): Promise<{ lines: MatchedPoLine[]; purchaseOrdersScanned: number; truncated: boolean }> {
  const catalogIds = [
    ...new Set(
      products.map((p) => p.catalogItem?.id).filter((id): id is number => typeof id === "number"),
    ),
  ];
  const companyIds = [
    ...new Set(
      products.map((p) => p.company?.id).filter((id): id is number => typeof id === "number"),
    ),
  ];
  if (catalogIds.length === 0 || companyIds.length === 0) {
    return { lines: [], purchaseOrdersScanned: 0, truncated: false };
  }
  const salesOrderIds = new Set(
    products.map((p) => p.salesOrder?.id).filter((id): id is number => typeof id === "number"),
  );

  const since = new Date(Date.now() - lookbackDays * 86_400_000);
  const poConditions = `customerCompany/id in (${companyIds.join(",")}) and (closedFlag = false or poDate >= ${cwDate(since)})`;
  const pos = await client.get<PurchaseOrderRecord[]>("/procurement/purchaseorders", {
    conditions: poConditions,
    orderBy: "poDate desc",
    page: 1,
    pageSize: PO_SCAN_LIMIT,
  });
  const poList = Array.isArray(pos) ? pos.filter((po) => typeof po.id === "number") : [];
  const truncated = poList.length >= PO_SCAN_LIMIT;

  const perPo = await mapWithConcurrency(poList, CHILD_CONCURRENCY, async (po) => {
    const lines = await fetchAllPages<PurchaseOrderLineRecord>(
      client,
      `/procurement/purchaseorders/${po.id}/lineitems`,
      { conditions: `product/id in (${catalogIds.join(",")})` },
      5,
    );
    return lines.map((line) => {
      const bySalesOrder = (line.salesOrder ?? []).some(
        (so) => typeof so.id === "number" && salesOrderIds.has(so.id),
      );
      return flattenLine(po, line, bySalesOrder ? "salesOrder" : "customerCompanyAndCatalogItem");
    });
  });

  return { lines: perPo.flat(), purchaseOrdersScanned: poList.length, truncated };
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const scopeSchema = {
  projectId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("ConnectWise project ID. Give projectId or ticketId (or both)"),
  ticketId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("ConnectWise service or project ticket ID. Give projectId or ticketId (or both)"),
};

function requireScope(projectId?: number, ticketId?: number) {
  if (projectId === undefined && ticketId === undefined) {
    return {
      content: [{ type: "text" as const, text: "Give projectId or ticketId." }],
      isError: true as const,
    };
  }
  return undefined;
}

/**
 * Register the project and ticket procurement status tools: product status
 * with received and awaiting quantities, purchase order lines and receipts
 * for a project or ticket, and per-catalog-item inventory on hand.
 */
export function registerProjectProcurementTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_get_catalog_item_inventory",
    "Get the on-hand stock for one catalog item, one row per warehouse bin, plus the total. Reads GET /procurement/catalog/{id}/inventory, which needs only the Procurement > Product Catalog security permission (the warehouse bin scan in cw_get_inventory_on_hand also needs System > Table Setup). Give catalogItemId, or identifier (the SKU) to look the item up first. Zero-quantity rows are dropped unless includeZero is true.",
    {
      catalogItemId: z.number().int().positive().optional().describe("Catalog item ID"),
      identifier: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe("Catalog item identifier (SKU). Used when catalogItemId is not given"),
      includeZero: z.boolean().optional().describe("Keep bins with zero on hand (default: false)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ catalogItemId, identifier, includeZero }) => {
      let id = catalogItemId;
      let item: { id?: number; identifier?: string; description?: string } | undefined;
      if (id === undefined) {
        if (!identifier) {
          return {
            content: [{ type: "text" as const, text: "Give catalogItemId or identifier." }],
            isError: true as const,
          };
        }
        const found = await client.get<Array<{ id?: number; identifier?: string; description?: string }>>(
          "/procurement/catalog",
          { conditions: `identifier = ${cwQuote(identifier)}`, page: 1, pageSize: 2 },
        );
        item = Array.isArray(found) ? found[0] : undefined;
        if (!item || typeof item.id !== "number") {
          return {
            content: [{ type: "text" as const, text: `No catalog item with identifier ${cwQuote(identifier)}.` }],
            isError: true as const,
          };
        }
        id = item.id;
      }

      const rows = await fetchAllPages<CatalogInventoryRecord>(
        client,
        `/procurement/catalog/${id}/inventory`,
      );
      const kept = rows
        .filter((r) => includeZero || num(r.onHand) !== 0)
        .map((r) => ({
          warehouseId: r.warehouse?.id ?? null,
          warehouse: r.warehouse?.name ?? null,
          warehouseBinId: r.warehouseBin?.id ?? null,
          warehouseBin: r.warehouseBin?.name ?? null,
          onHand: num(r.onHand),
          serialNumbers: (r.serialNumbers ?? [])
            .map((s) => s.serialNumber)
            .filter((s): s is string => Boolean(s)),
        }));

      return textResult({
        catalogItemId: id,
        identifier: item?.identifier ?? rows[0]?.catalogItem?.identifier ?? identifier ?? null,
        description: item?.description ?? rows[0]?.catalogItem?.name ?? null,
        totalOnHand: kept.reduce((sum, r) => sum + r.onHand, 0),
        bins: kept,
      });
    },
  );

  server.tool(
    "cw_get_project_product_status",
    "For a project or ticket, list every product placed on it with its stock position: ordered quantity, quantity picked (received and allocated from stock), shipped, still awaiting, and a status of in_stock, partially_received, awaiting_arrival (on a purchase order or PO approved), awaiting_pick (to be filled from stock, not yet picked: check cw_get_catalog_item_inventory), not_ordered (needs purchasing, no PO yet), shipped, not_stocked (service or agreement lines) or cancelled. Answers 'which products for project N are in stock and which are still awaiting arrival'. With matchPurchaseOrders (default true) it also attaches the purchase order lines for the same catalog items on the customer's purchase orders, with received quantity, received status, date received and tracking. ConnectWise gives a purchase order line no project or ticket link, so each match says how it was made (salesOrder, or customerCompanyAndCatalogItem, which can also match another job for the same customer ordering the same SKU). Needs Procurement > Products, and Procurement > Purchase Orders for the PO match.",
    {
      ...scopeSchema,
      includeCancelled: z
        .boolean()
        .optional()
        .describe("Include cancelled product lines (default: false)"),
      matchPurchaseOrders: z
        .boolean()
        .optional()
        .describe("Attach matching purchase order lines and receipts (default: true)"),
      poLookbackDays: z
        .number()
        .int()
        .positive()
        .max(1825)
        .optional()
        .describe(`Closed purchase orders older than this many days are not matched (default: ${DEFAULT_PO_LOOKBACK_DAYS}). Open ones always are`),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ projectId, ticketId, includeCancelled, matchPurchaseOrders, poLookbackDays }) => {
      const missing = requireScope(projectId, ticketId);
      if (missing) return missing;

      const products = await loadProducts(client, projectId, ticketId, includeCancelled ?? false);

      const fulfilment = await mapWithConcurrency(products, CHILD_CONCURRENCY, async (p) => {
        if (typeof p.id !== "number") return { picked: 0, shipped: 0, details: [] as PickingShippingRecord[] };
        const details = await fetchAllPages<PickingShippingRecord>(
          client,
          `/procurement/products/${p.id}/pickingShippingDetails`,
          {},
          5,
        );
        return {
          picked: details.reduce((s, d) => s + num(d.pickedQuantity), 0),
          shipped: details.reduce((s, d) => s + num(d.shippedQuantity), 0),
          details,
        };
      });

      const po =
        (matchPurchaseOrders ?? true)
          ? await matchPurchaseOrderLines(client, products, poLookbackDays ?? DEFAULT_PO_LOOKBACK_DAYS)
          : undefined;

      const rows = products.map((p, i) => {
        const f = fulfilment[i];
        const lines = po?.lines
          .filter((l) => l.catalogItemId === p.catalogItem?.id)
          .map((l) => lineForProduct(l, p));
        const c = classifyProduct(p, f.picked, f.shipped, lines);
        return {
          productItemId: p.id ?? null,
          catalogItemId: p.catalogItem?.id ?? null,
          identifier: p.catalogItem?.identifier ?? null,
          description: p.description ?? null,
          productClass: p.productClass ?? null,
          ticketId: p.ticket?.id ?? null,
          projectId: p.project?.id ?? null,
          phase: p.phase?.name ?? null,
          status: c.status,
          orderedQuantity: c.orderedQuantity,
          pickedQuantity: f.picked,
          shippedQuantity: f.shipped,
          awaitingQuantity: c.awaitingQuantity,
          needToPurchase: p.needToPurchaseFlag ?? null,
          poApproved: p.poApprovedFlag ?? null,
          dropship: p.dropshipFlag ?? null,
          pickedFrom: f.details
            .filter((d) => num(d.pickedQuantity) > 0)
            .map((d) => ({
              warehouse: d.warehouse?.name ?? null,
              warehouseBin: d.warehouseBin?.name ?? null,
              picked: num(d.pickedQuantity),
              shipped: num(d.shippedQuantity),
            })),
          ...(lines ? { purchaseOrderLines: lines } : {}),
        };
      });

      const count = (s: ProductStockStatus) => rows.filter((r) => r.status === s).length;
      return textResult({
        scope: { projectId: projectId ?? null, ticketId: ticketId ?? null },
        summary: {
          productLines: rows.length,
          inStock: count("in_stock"),
          shipped: count("shipped"),
          partiallyReceived: count("partially_received"),
          awaitingArrival: count("awaiting_arrival"),
          awaitingPick: count("awaiting_pick"),
          notOrdered: count("not_ordered"),
          notStocked: count("not_stocked"),
          cancelled: count("cancelled"),
          ...(po
            ? { purchaseOrdersScanned: po.purchaseOrdersScanned, purchaseOrderScanTruncated: po.truncated }
            : {}),
          statusBasis:
            "pickedQuantity is stock allocated to the product (a received PO line for a ticket or project product is picked to it). Purchase order lines are matched by sales order, else by customer company and catalog item, because ConnectWise gives a PO line no project or ticket link.",
        },
        products: rows,
      });
    },
  );

  server.tool(
    "cw_get_project_purchase_order_lines",
    "List the purchase order lines and receipts for the products on a project or ticket: purchase order number and status, vendor, quantity, received quantity, outstanding quantity, received status (Waiting, FullyReceived, PartiallyReceiveCancelRest, PartiallyReceiveCloneRest), date received, expected ship and arrival dates, tracking number and the receiving warehouse and bin. ConnectWise gives a purchase order line no project or ticket link, so lines are found on the customer's purchase orders for the same catalog items, and each says how it was matched (salesOrder, or customerCompanyAndCatalogItem). Needs Procurement > Products and Procurement > Purchase Orders.",
    {
      ...scopeSchema,
      outstandingOnly: z
        .boolean()
        .optional()
        .describe("Only lines with quantity still to receive (default: false)"),
      poLookbackDays: z
        .number()
        .int()
        .positive()
        .max(1825)
        .optional()
        .describe(`Closed purchase orders older than this many days are skipped (default: ${DEFAULT_PO_LOOKBACK_DAYS}). Open ones are always read`),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ projectId, ticketId, outstandingOnly, poLookbackDays }) => {
      const missing = requireScope(projectId, ticketId);
      if (missing) return missing;

      const products = await loadProducts(client, projectId, ticketId, false);
      const po = await matchPurchaseOrderLines(
        client,
        products,
        poLookbackDays ?? DEFAULT_PO_LOOKBACK_DAYS,
      );
      const lines = outstandingOnly ? po.lines.filter((l) => l.outstandingQuantity > 0) : po.lines;

      return textResult({
        scope: { projectId: projectId ?? null, ticketId: ticketId ?? null },
        summary: {
          productLines: products.length,
          purchaseOrdersScanned: po.purchaseOrdersScanned,
          purchaseOrderScanTruncated: po.truncated,
          lineCount: lines.length,
          fullyReceived: lines.filter((l) => l.outstandingQuantity === 0 && !l.canceled).length,
          outstanding: lines.filter((l) => l.outstandingQuantity > 0).length,
          totalOutstandingQuantity: lines.reduce((s, l) => s + l.outstandingQuantity, 0),
        },
        lines,
      });
    },
  );
}
