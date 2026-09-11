/**
 * Contract tests for the finance and procurement tools.
 *
 * These drive the Cloudflare Workers entrypoint (same MCP server factory as
 * stdio / Node HTTP) over real MCP JSON-RPC, with global fetch stubbed so the
 * assertion is on the ConnectWise URL each tool actually builds. That is the
 * thing worth pinning: a tool can be registered, typecheck, and still call the
 * wrong path.
 *
 * Every path asserted here was verified against ConnectWise's published
 * OpenAPI contract ("Connectwise Manage Public Endpoints", 2025.16, openapi
 * 3.0.1), not taken from the upstream forks.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";

const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "X-CW-Company-Id": "acme",
  "X-CW-Public-Key": "pub",
  "X-CW-Private-Key": "priv",
  "X-CW-Client-Id": "client-guid",
};

const API_BASE = "https://api-na.myconnectwise.net/v4_6_release/apis/3.0";

function fakeResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

async function mcp(body: unknown): Promise<unknown> {
  const res = await worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(body),
    }),
    { AUTH_MODE: "gateway" },
  );
  expect(res.status).toBe(200);
  return res.json();
}

async function listToolNames(): Promise<string[]> {
  const body = (await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  })) as { result?: { tools?: { name: string }[] } };
  return (body.result?.tools ?? []).map((t) => t.name);
}

/** Call a tool and return the ConnectWise URL it requested. */
async function callAndCaptureUrl(
  name: string,
  args: Record<string, unknown>,
): Promise<URL> {
  const fetchMock = vi.fn().mockResolvedValue(fakeResponse([]));
  vi.stubGlobal("fetch", fetchMock);

  const body = (await mcp({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result?: { isError?: boolean } };

  expect(body.result?.isError).not.toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return new URL((fetchMock.mock.calls[0] as [string])[0]);
}

const NEW_TOOLS = [
  "cw_search_purchase_orders",
  "cw_get_purchase_order",
  "cw_get_purchase_order_items",
  "cw_search_procurement_products",
  "cw_get_procurement_product",
  "cw_search_sales_orders",
  "cw_get_sales_order",
  "cw_get_sales_order_products",
  "cw_search_agreement_recaps",
  "cw_get_agreement_recap",
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("finance and procurement tools", () => {
  it("advertises every new tool once credentials are present", async () => {
    const names = await listToolNames();
    for (const tool of NEW_TOOLS) {
      expect(names).toContain(tool);
    }
    // No accidental duplicate registrations.
    expect(new Set(names).size).toBe(names.length);
  });

  describe("endpoint paths match the CW 2025.16 contract", () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["cw_search_purchase_orders", {}, "/procurement/purchaseorders"],
      ["cw_get_purchase_order", { id: 77 }, "/procurement/purchaseorders/77"],
      [
        "cw_get_purchase_order_items",
        { purchaseOrderId: 77 },
        "/procurement/purchaseorders/77/lineitems",
      ],
      ["cw_search_procurement_products", {}, "/procurement/products"],
      ["cw_get_procurement_product", { id: 31 }, "/procurement/products/31"],
      ["cw_search_sales_orders", {}, "/sales/orders"],
      ["cw_get_sales_order", { id: 5 }, "/sales/orders/5"],
      ["cw_get_sales_order_products", { salesOrderId: 5 }, "/procurement/products"],
      // The collection recap path keeps its trailing slash, as the contract has it.
      ["cw_search_agreement_recaps", {}, "/finance/agreementrecap/"],
      ["cw_get_agreement_recap", { id: 9 }, "/finance/agreementrecap/9"],
    ];

    it.each(cases)("%s hits %s", async (name, args, path) => {
      const url = await callAndCaptureUrl(name, args);
      expect(url.pathname).toBe(`/v4_6_release/apis/3.0${path}`);
      expect(url.origin + url.pathname).toBe(`${API_BASE}${path}`);
    });
  });

  describe("collection search parameters", () => {
    it("defaults page to 1 and pageSize to 25", async () => {
      const url = await callAndCaptureUrl("cw_search_purchase_orders", {});
      expect(url.searchParams.get("page")).toBe("1");
      expect(url.searchParams.get("pageSize")).toBe("25");
    });

    it("passes conditions, orderBy and paging through verbatim", async () => {
      const url = await callAndCaptureUrl("cw_search_sales_orders", {
        conditions: "status/name = 'Open'",
        orderBy: "id desc",
        page: 3,
        pageSize: 100,
      });
      expect(url.searchParams.get("conditions")).toBe("status/name = 'Open'");
      expect(url.searchParams.get("orderBy")).toBe("id desc");
      expect(url.searchParams.get("page")).toBe("3");
      expect(url.searchParams.get("pageSize")).toBe("100");
    });

    it("omits conditions and orderBy entirely when not supplied", async () => {
      const url = await callAndCaptureUrl("cw_search_procurement_products", {});
      expect(url.searchParams.has("conditions")).toBe(false);
      expect(url.searchParams.has("orderBy")).toBe(false);
    });

    it("scopes purchase order line items to their parent order", async () => {
      const url = await callAndCaptureUrl("cw_get_purchase_order_items", {
        purchaseOrderId: 1234,
        pageSize: 50,
      });
      expect(url.pathname).toContain("/procurement/purchaseorders/1234/lineitems");
      expect(url.searchParams.get("pageSize")).toBe("50");
    });
  });

  describe("cw_get_sales_order_products scoping", () => {
    it("always filters on the sales order", async () => {
      const url = await callAndCaptureUrl("cw_get_sales_order_products", {
        salesOrderId: 42,
      });
      expect(url.searchParams.get("conditions")).toBe("salesOrder/id=42");
    });

    it("ANDs caller conditions with the sales order scope rather than replacing it", async () => {
      const url = await callAndCaptureUrl("cw_get_sales_order_products", {
        salesOrderId: 42,
        conditions: "cancelledFlag = false",
      });
      expect(url.searchParams.get("conditions")).toBe(
        "salesOrder/id=42 and (cancelledFlag = false)",
      );
    });

    it("cannot be talked out of its scope by a caller-supplied condition", async () => {
      const url = await callAndCaptureUrl("cw_get_sales_order_products", {
        salesOrderId: 42,
        conditions: "salesOrder/id=99",
      });
      expect(url.searchParams.get("conditions")).toContain("salesOrder/id=42 and (");
    });
  });

  describe("result shape", () => {
    it("returns the ConnectWise payload as pretty-printed JSON text", async () => {
      const payload = [{ id: 77, poNumber: "PO-77", subTotal: 1234.56 }];
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse(payload));
      vi.stubGlobal("fetch", fetchMock);

      const body = (await mcp({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "cw_search_purchase_orders", arguments: {} },
      })) as { result?: { content?: { type: string; text: string }[] } };

      const content = body.result?.content?.[0];
      expect(content?.type).toBe("text");
      expect(JSON.parse(content?.text ?? "null")).toEqual(payload);
    });

    it("surfaces a ConnectWise error instead of throwing", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('{"code":"Forbidden"}'),
        json: () => Promise.resolve({ code: "Forbidden" }),
      } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      const body = (await mcp({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "cw_search_purchase_orders", arguments: {} },
      })) as { result?: { isError?: boolean; content?: { text?: string }[] } };

      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toContain("403");
    });
  });
});
