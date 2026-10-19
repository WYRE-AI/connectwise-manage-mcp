import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";

/**
 * Finance and procurement tools (ConnectWise Procurement + Sales APIs).
 *
 * Covers the buy side an MSP finance team works from day to day: purchase
 * order headers and their line items, procurement product items (the
 * instantiated products sitting on tickets, projects and orders — distinct
 * from the catalog SKU definitions in `catalog.ts`), and sales orders.
 *
 * Every tool here is read-only. Paths verified against ConnectWise's published
 * OpenAPI contract ("Connectwise Manage Public Endpoints", 2025.16, openapi
 * 3.0.1) rather than taken from the upstream forks.
 *
 * Two casing details from that contract are load-bearing and easy to get
 * wrong: the purchase-order child segment is `lineitems`, all lowercase and
 * with no trailing slash (`lineItems` appears nowhere in the contract), and
 * `/sales/orders/{id}/lineitems/` — which this file does NOT use — carries a
 * trailing slash even though the purchase-order equivalent does not. CW is
 * not symmetric here.
 */
export function registerFinanceProcurementTools(
  server: McpServer,
  client: CwManageClient,
) {
  // -------------------------------------------------------------------------
  // Purchase orders
  // -------------------------------------------------------------------------

  server.tool(
    "cw_search_purchase_orders",
    "Search purchase orders (the buy side) in ConnectWise Manage. Use 'conditions' for CW query syntax (e.g. \"closedFlag = false\", \"vendorCompany/name = 'Ingram'\", \"poDate > [2026-01-01T00:00:00Z]\").",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by (e.g. 'poDate desc')"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/procurement/purchaseorders", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_purchase_order",
    "Get a specific purchase order by ID.",
    {
      id: z.number().describe("Purchase order ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/procurement/purchaseorders/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_purchase_order_items",
    "Get the line items on a specific purchase order, including unit cost, extended cost, quantity received, and receipt status.",
    {
      purchaseOrderId: z.number().describe("Purchase order ID"),
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by"),
    },
    async ({ purchaseOrderId, conditions, page, pageSize, orderBy }) => {
      const result = await client.get(
        `/procurement/purchaseorders/${purchaseOrderId}/lineitems`,
        {
          conditions,
          page: page ?? 1,
          pageSize: pageSize ?? 25,
          orderBy,
        },
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // -------------------------------------------------------------------------
  // Procurement products
  //
  // These are product *items* — a catalog SKU instantiated onto a ticket,
  // project, sales order or opportunity, carrying its own price, cost and
  // margin. The catalog SKU definitions themselves live in `catalog.ts`.
  // -------------------------------------------------------------------------

  server.tool(
    "cw_search_procurement_products",
    "Search procurement product items — catalog SKUs placed on a ticket, project, sales order or opportunity, with their own price, cost and margin. For the catalog SKU definitions themselves use cw_search_catalog_items instead. Use 'conditions' for CW query syntax (e.g. \"company/id = 42\", \"invoice/id = 1001\").",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by (e.g. 'id desc')"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/procurement/products", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_procurement_product",
    "Get a specific procurement product item by ID.",
    {
      id: z.number().describe("Procurement product item ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/procurement/products/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // -------------------------------------------------------------------------
  // Sales orders
  // -------------------------------------------------------------------------

  server.tool(
    "cw_search_sales_orders",
    "Search sales orders (the sell side) in ConnectWise Manage. Use 'conditions' for CW query syntax (e.g. \"status/name = 'Open'\", \"company/name = 'Acme'\"). For purchase orders use cw_search_purchase_orders instead.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by (e.g. 'id desc')"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/sales/orders", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_sales_order",
    "Get a specific sales order by ID.",
    {
      id: z.number().describe("Sales order ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/sales/orders/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_sales_order_products",
    "Get the procurement product items on a specific sales order. Always scoped to the given order; any extra 'conditions' are ANDed with that scope.",
    {
      salesOrderId: z.number().describe("Sales order ID"),
      conditions: z
        .string()
        .optional()
        .describe("Additional ConnectWise conditions, ANDed with the sales order filter"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by"),
    },
    async ({ salesOrderId, conditions, page, pageSize, orderBy }) => {
      const scope = `salesOrder/id=${salesOrderId}`;
      const result = await client.get("/procurement/products", {
        conditions: conditions ? `${scope} and (${conditions})` : scope,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
