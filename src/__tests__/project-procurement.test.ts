import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CwManageClient } from "../api-client.js";
import {
  classifyProduct,
  cwQuote,
  registerProjectProcurementTools,
  type MatchedPoLine,
} from "../tools/project-procurement.js";
import { registerProjectTools } from "../tools/projects.js";

type Params = Record<string, string | number | undefined>;
type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

class StubClient {
  calls: Array<{ path: string; params: Params }> = [];
  responder: (path: string, params: Params) => unknown = () => [];
  async get(path: string, params: Params = {}) {
    this.calls.push({ path, params });
    return this.responder(path, params);
  }
}

function setup(register = registerProjectProcurementTools) {
  const tools = new Map<string, { annotations?: Record<string, unknown>; handler: Handler }>();
  const server = {
    tool(name: string, _d: string, _s: unknown, a: unknown, h?: unknown) {
      if (typeof a === "function") tools.set(name, { handler: a as Handler });
      else tools.set(name, { annotations: a as Record<string, unknown>, handler: h as Handler });
    },
  };
  const client = new StubClient();
  register(server as unknown as McpServer, client as unknown as CwManageClient);
  const raw = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.handler(args);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    JSON.parse((await raw(name, args)).content[0].text);
  return { tools, client, call, raw };
}

// Project 875: three products for company 42.
//  - 101: SKU A x2, picked 2            -> in_stock
//  - 102: SKU B x5, picked 2            -> partially_received
//  - 103: SKU C x1, nothing picked, PO line waiting -> awaiting_arrival
//  - 104: labour (Service)              -> not_stocked
const PRODUCTS = [
  { id: 101, catalogItem: { id: 1, identifier: "A" }, quantity: 2, productClass: "Inventory", company: { id: 42 }, project: { id: 875 } },
  { id: 102, catalogItem: { id: 2, identifier: "B" }, quantity: 5, productClass: "Inventory", company: { id: 42 }, project: { id: 875 } },
  { id: 103, catalogItem: { id: 3, identifier: "C" }, quantity: 1, productClass: "Inventory", needToPurchaseFlag: true, company: { id: 42 }, project: { id: 875 }, salesOrder: { id: 9 } },
  { id: 104, catalogItem: { id: 4, identifier: "LAB" }, quantity: 3, productClass: "Service", company: { id: 42 }, project: { id: 875 } },
];

function projectFixture() {
  return (path: string): unknown => {
    if (path === "/procurement/products") return PRODUCTS;
    if (path === "/procurement/products/101/pickingShippingDetails")
      return [{ pickedQuantity: 2, shippedQuantity: 0, warehouse: { name: "Main" }, warehouseBin: { name: "A1" } }];
    if (path === "/procurement/products/102/pickingShippingDetails") return [{ pickedQuantity: 2, shippedQuantity: 0 }];
    if (path.endsWith("/pickingShippingDetails")) return [];
    if (path === "/procurement/purchaseorders")
      return [{ id: 70, poNumber: "PO-70", status: { name: "Ordered" }, vendorCompany: { name: "Vendor" } }];
    if (path === "/procurement/purchaseorders/70/lineitems")
      return [
        { id: 1, product: { id: 3 }, quantity: 1, receivedQuantity: 0, receivedStatus: "Waiting", trackingNumber: "1Z", salesOrder: [{ id: 9 }] },
        { id: 2, product: { id: 2 }, quantity: 5, receivedQuantity: 2, receivedStatus: "PartiallyReceiveCloneRest", dateReceived: "2026-11-20T00:00:00Z" },
      ];
    return [];
  };
}

describe("cw_get_project_product_status", () => {
  it("scopes products to the project and drops cancelled lines by default", async () => {
    const { client, call } = setup();
    client.responder = projectFixture();
    await call("cw_get_project_product_status", { projectId: 875 });
    const products = client.calls.find((c) => c.path === "/procurement/products")!;
    expect(products.params.conditions).toBe("project/id = 875 and cancelledFlag = false");
  });

  it("scopes to a ticket", async () => {
    const { client, call } = setup();
    await call("cw_get_project_product_status", { ticketId: 5, includeCancelled: true });
    expect(client.calls[0].params.conditions).toBe("ticket/id = 5");
  });

  it("refuses a call with no project or ticket", async () => {
    const { raw } = setup();
    const res = await raw("cw_get_project_product_status", {});
    expect(res.isError).toBe(true);
  });

  it("splits in stock from awaiting arrival and attaches PO receipts", async () => {
    const { client, call } = setup();
    client.responder = projectFixture();
    const result = await call("cw_get_project_product_status", { projectId: 875 });

    const byId = Object.fromEntries(result.products.map((p: { productItemId: number }) => [p.productItemId, p]));
    expect(byId[101]).toMatchObject({ status: "in_stock", pickedQuantity: 2, awaitingQuantity: 0 });
    expect(byId[102]).toMatchObject({ status: "partially_received", awaitingQuantity: 3 });
    expect(byId[103]).toMatchObject({ status: "awaiting_arrival", awaitingQuantity: 1 });
    expect(byId[104].status).toBe("not_stocked");
    expect(byId[103].purchaseOrderLines[0]).toMatchObject({
      poNumber: "PO-70",
      receivedStatus: "Waiting",
      outstandingQuantity: 1,
      trackingNumber: "1Z",
      matchedBy: "salesOrder",
    });
    expect(byId[102].purchaseOrderLines[0].matchedBy).toBe("customerCompanyAndCatalogItem");
    expect(result.summary).toMatchObject({ inStock: 1, partiallyReceived: 1, awaitingArrival: 1, notStocked: 1 });
  });

  it("reads POs for the customer company and only the project's catalog items", async () => {
    const { client, call } = setup();
    client.responder = projectFixture();
    await call("cw_get_project_product_status", { projectId: 875 });
    const pos = client.calls.find((c) => c.path === "/procurement/purchaseorders")!;
    expect(String(pos.params.conditions)).toMatch(/^customerCompany\/id in \(42\) and \(closedFlag = false or poDate >= \[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\]\)$/);
    const lines = client.calls.find((c) => c.path === "/procurement/purchaseorders/70/lineitems")!;
    expect(lines.params.conditions).toBe("product/id in (1,2,3,4)");
  });

  it("labels a sales-order match only on the product that owns that sales order", async () => {
    const { client, call } = setup();
    const products = [
      { id: 201, catalogItem: { id: 3 }, quantity: 1, productClass: "Inventory", company: { id: 42 }, salesOrder: { id: 9 } },
      { id: 202, catalogItem: { id: 3 }, quantity: 1, productClass: "Inventory", company: { id: 42 }, salesOrder: { id: 10 } },
    ];
    client.responder = (path) => {
      if (path === "/procurement/products") return products;
      if (path === "/procurement/purchaseorders") return [{ id: 70, poNumber: "PO-70" }];
      if (path === "/procurement/purchaseorders/70/lineitems")
        return [{ id: 1, product: { id: 3 }, quantity: 1, receivedQuantity: 0, salesOrder: [{ id: 9 }] }];
      return [];
    };
    const result = await call("cw_get_project_product_status", { projectId: 875 });
    const byId = Object.fromEntries(result.products.map((p: { productItemId: number }) => [p.productItemId, p]));
    expect(byId[201].purchaseOrderLines[0].matchedBy).toBe("salesOrder");
    expect(byId[202].purchaseOrderLines[0].matchedBy).toBe("customerCompanyAndCatalogItem");
    expect(byId[202].purchaseOrderLines[0].salesOrderIds).toEqual([9]);
  });

  it("skips the PO match when asked", async () => {
    const { client, call } = setup();
    client.responder = projectFixture();
    const result = await call("cw_get_project_product_status", { projectId: 875, matchPurchaseOrders: false });
    expect(client.calls.some((c) => c.path.startsWith("/procurement/purchaseorders"))).toBe(false);
    expect(result.products[0].purchaseOrderLines).toBeUndefined();
  });

  it("is annotated read-only", () => {
    const { tools } = setup();
    for (const name of ["cw_get_project_product_status", "cw_get_project_purchase_order_lines", "cw_get_catalog_item_inventory"]) {
      expect(tools.get(name)!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });
});

describe("cw_get_project_purchase_order_lines", () => {
  it("lists matched lines and filters to outstanding", async () => {
    const { client, call } = setup();
    client.responder = projectFixture();
    const all = await call("cw_get_project_purchase_order_lines", { projectId: 875 });
    expect(all.lines).toHaveLength(2);
    expect(all.summary.totalOutstandingQuantity).toBe(4);
    const open = await call("cw_get_project_purchase_order_lines", { projectId: 875, outstandingOnly: true });
    expect(open.lines.every((l: MatchedPoLine) => l.outstandingQuantity > 0)).toBe(true);
  });

  it("makes no PO calls when the project has no products", async () => {
    const { client, call } = setup();
    const result = await call("cw_get_project_purchase_order_lines", { projectId: 1 });
    expect(result.lines).toEqual([]);
    expect(client.calls.some((c) => c.path.startsWith("/procurement/purchaseorders"))).toBe(false);
  });
});

describe("cw_get_catalog_item_inventory", () => {
  it("reads the catalog item inventory endpoint and totals it", async () => {
    const { client, call } = setup();
    client.responder = (path) =>
      path === "/procurement/catalog/500/inventory"
        ? [
            { catalogItem: { id: 500, identifier: "SKU" }, warehouse: { id: 1, name: "Main" }, warehouseBin: { id: 10, name: "A1" }, onHand: 4, serialNumbers: [{ serialNumber: "S1" }] },
            { warehouse: { id: 1 }, warehouseBin: { id: 11 }, onHand: 0 },
          ]
        : [];
    const result = await call("cw_get_catalog_item_inventory", { catalogItemId: 500 });
    expect(client.calls.every((c) => !c.path.startsWith("/procurement/warehouse"))).toBe(true);
    expect(result.totalOnHand).toBe(4);
    expect(result.bins).toHaveLength(1);
    expect(result.bins[0].serialNumbers).toEqual(["S1"]);
  });

  it("looks the item up by identifier, quoting it", async () => {
    const { client, call } = setup();
    client.responder = (path) =>
      path === "/procurement/catalog" ? [{ id: 7, identifier: 'X"1', description: "Thing" }] : [];
    const result = await call("cw_get_catalog_item_inventory", { identifier: 'X"1' });
    expect(client.calls[0].params.conditions).toBe('identifier = "X\\"1"');
    expect(client.calls[1].path).toBe("/procurement/catalog/7/inventory");
    expect(result.catalogItemId).toBe(7);
  });

  it("reports an unknown identifier as an error", async () => {
    const { raw } = setup();
    const res = await raw("cw_get_catalog_item_inventory", { identifier: "nope" });
    expect(res.isError).toBe(true);
  });
});

describe("classifyProduct", () => {
  const line = (over: Partial<MatchedPoLine>): MatchedPoLine => ({
    purchaseOrderId: 1, poNumber: "P", poStatus: null, vendor: null, lineId: 1, catalogItemId: 1,
    quantity: 1, receivedQuantity: 0, outstandingQuantity: 1, receivedStatus: "Waiting", dateReceived: null,
    expectedShipDate: null, expectedArrivalDate: null, trackingNumber: null, canceled: false,
    warehouse: null, warehouseBin: null, salesOrderIds: [], matchedBy: "customerCompanyAndCatalogItem", ...over,
  });

  it("marks a product needing purchase with no PO as not_ordered", () => {
    expect(classifyProduct({ quantity: 1, needToPurchaseFlag: true }, 0, 0, []).status).toBe("not_ordered");
  });
  it("marks a PO-approved product as awaiting_arrival", () => {
    expect(classifyProduct({ quantity: 1, needToPurchaseFlag: true, poApprovedFlag: true }, 0, 0, []).status).toBe("awaiting_arrival");
  });
  it("marks a stock product not yet picked as awaiting_pick", () => {
    expect(classifyProduct({ quantity: 1 }, 0, 0, []).status).toBe("awaiting_pick");
  });
  it("marks received-but-unpicked as partially_received", () => {
    expect(classifyProduct({ quantity: 2 }, 0, 0, [line({ receivedQuantity: 2, outstandingQuantity: 0 })]).status).toBe("partially_received");
  });
  it("marks a shipped product as shipped", () => {
    expect(classifyProduct({ quantity: 2 }, 2, 2, undefined).status).toBe("shipped");
  });
  it("nets cancelled quantity out of the order", () => {
    expect(classifyProduct({ quantity: 3, quantityCancelled: 1 }, 2, 0, undefined)).toMatchObject({ status: "in_stock", orderedQuantity: 2 });
    expect(classifyProduct({ quantity: 1, quantityCancelled: 1, cancelledFlag: true }, 0, 0, undefined).status).toBe("cancelled");
  });
});

describe("cwQuote", () => {
  it("escapes quotes and backslashes", () => {
    expect(cwQuote('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe("cw_search_projects active filter", () => {
  it("defaults to open projects", async () => {
    const { client, call } = setup(registerProjectTools as never);
    await call("cw_search_projects", {});
    expect(client.calls[0].params.conditions).toBe("closedFlag = false");
  });
  it("ANDs caller conditions with the active filter", async () => {
    const { client, call } = setup(registerProjectTools as never);
    await call("cw_search_projects", { conditions: "company/id = 42 or company/id = 43", fields: "id,name" });
    expect(client.calls[0].params.conditions).toBe("closedFlag = false and (company/id = 42 or company/id = 43)");
    expect(client.calls[0].params.fields).toBe("id,name");
  });
  it("includes closed projects when activeOnly is false", async () => {
    const { client, call } = setup(registerProjectTools as never);
    await call("cw_search_projects", { activeOnly: false });
    expect(client.calls[0].params.conditions).toBeUndefined();
  });
});
