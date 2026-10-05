/**
 * Invoice line detail: products, time, and expenses billed onto an invoice.
 *
 * Manage has no /finance/invoices/{id}/products (or time, or expense) child.
 * These tools GET the collections that carry an invoice reference and pin
 * the verb, path, and conditions query.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";
import { invoiceScopedConditions } from "../tools/agreements.js";

const GATEWAY_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "X-CW-Company-Id": "acme",
  "X-CW-Public-Key": "pub",
  "X-CW-Private-Key": "priv",
  "X-CW-Client-Id": "client-guid",
};

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

async function mcp(method: string, params: unknown, id = 1): Promise<Record<string, unknown>> {
  const res = await worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: GATEWAY_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
    { AUTH_MODE: "gateway" },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function toolText(body: Record<string, unknown>): string {
  const result = body.result as { content?: { text?: string }[]; isError?: boolean } | undefined;
  expect(result?.isError).not.toBe(true);
  return result?.content?.[0]?.text ?? "";
}

function calledGet(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = fetchMock.mock.calls[index] as [string, { method?: string }];
  const parsed = new URL(url);
  return {
    method: init?.method ?? "GET",
    path: parsed.pathname,
    conditions: parsed.searchParams.get("conditions"),
    page: parsed.searchParams.get("page"),
    pageSize: parsed.searchParams.get("pageSize"),
    orderBy: parsed.searchParams.get("orderBy"),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("invoiceScopedConditions", () => {
  it("scopes to the invoice and parenthesizes extra conditions", () => {
    expect(invoiceScopedConditions(42)).toBe("invoice/id = 42");
    expect(invoiceScopedConditions(42, "  ")).toBe("invoice/id = 42");
    expect(invoiceScopedConditions(42, 'productClass = "Agreement" or billableOption = "Billable"')).toBe(
      'invoice/id = 42 and (productClass = "Agreement" or billableOption = "Billable")',
    );
  });

  it("allows balanced groups and parentheses inside string literals", () => {
    expect(invoiceScopedConditions(42, '(a = 1 or b = 2) and description = "x) or (y"')).toBe(
      'invoice/id = 42 and ((a = 1 or b = 2) and description = "x) or (y")',
    );
  });

  it("rejects extra conditions that could escape the invoice scope", () => {
    expect(() => invoiceScopedConditions(42, "invoice/id != 42) or (invoice/id != 42")).toThrow(
      /did not open/,
    );
    expect(() => invoiceScopedConditions(42, "(a = 1")).toThrow(/unbalanced/);
    expect(() => invoiceScopedConditions(42, 'a = "x')).toThrow(/unterminated/);
  });
});

describe("invoice line tools", () => {
  it("lists the read tools and does not invent an invoice-products path parameter", async () => {
    const body = await mcp("tools/list", {});
    const tools = (body.result as { tools: { name: string; description?: string }[] }).tools;
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(byName.cw_get_invoice_products).toBeDefined();
    expect(byName.cw_get_invoice_time_entries).toBeDefined();
    expect(byName.cw_get_invoice_expenses).toBeDefined();
    expect(byName.cw_get_invoice_products.description).toMatch(/\/procurement\/products/);
    expect(byName.cw_get_invoice_products.description).toMatch(/no \/finance\/invoices/);
    expect(tools).toHaveLength(60);
  });

  it("GETs procurement products for the invoice with default paging", async () => {
    const lines = [
      {
        id: 9,
        description: "Managed workstation",
        quantity: 12,
        price: 40,
        productClass: "Agreement",
        agreement: { id: 3, name: "Gold" },
        agreementAmount: 480,
        invoice: { id: 42 },
      },
    ];
    const fetchMock = vi.fn().mockResolvedValueOnce(fakeResponse(lines));
    vi.stubGlobal("fetch", fetchMock);

    const listed = await mcp("tools/call", {
      name: "cw_get_invoice_products",
      arguments: { invoiceId: 42 },
    });

    expect(JSON.parse(toolText(listed))).toEqual(lines);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calledGet(fetchMock)).toEqual({
      method: "GET",
      path: "/v4_6_release/apis/3.0/procurement/products",
      conditions: "invoice/id = 42",
      page: "1",
      pageSize: "25",
      orderBy: null,
    });
  });

  it("ANDs extra product conditions and forwards page, pageSize, and orderBy", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fakeResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await mcp("tools/call", {
      name: "cw_get_invoice_products",
      arguments: {
        invoiceId: 42,
        conditions: 'productClass = "Agreement"',
        page: 2,
        pageSize: 100,
        orderBy: "sequenceNumber",
      },
    });

    expect(calledGet(fetchMock)).toEqual({
      method: "GET",
      path: "/v4_6_release/apis/3.0/procurement/products",
      conditions: 'invoice/id = 42 and (productClass = "Agreement")',
      page: "2",
      pageSize: "100",
      orderBy: "sequenceNumber",
    });
  });

  it("GETs time entries billed on the invoice", async () => {
    const entries = [
      {
        id: 15,
        actualHours: 1.5,
        hoursBilled: 1.5,
        invoiceHours: 1.5,
        hourlyRate: 150,
        status: "BilledAgreement",
        agreement: { id: 3, name: "Gold" },
        agreementHours: 1.5,
        agreementAmount: 0,
        invoice: { id: 42 },
      },
    ];
    const fetchMock = vi.fn().mockResolvedValueOnce(fakeResponse(entries));
    vi.stubGlobal("fetch", fetchMock);

    const listed = await mcp("tools/call", {
      name: "cw_get_invoice_time_entries",
      arguments: { invoiceId: 42, page: 1, pageSize: 50 },
    });

    expect(JSON.parse(toolText(listed))).toEqual(entries);
    expect(calledGet(fetchMock)).toEqual({
      method: "GET",
      path: "/v4_6_release/apis/3.0/time/entries",
      conditions: "invoice/id = 42",
      page: "1",
      pageSize: "50",
      orderBy: null,
    });
  });

  it("GETs expense entries billed on the invoice", async () => {
    const entries = [
      {
        id: 8,
        amount: 42.5,
        billAmount: 42.5,
        invoiceAmount: 42.5,
        invoice: { id: 42 },
      },
    ];
    const fetchMock = vi.fn().mockResolvedValueOnce(fakeResponse(entries));
    vi.stubGlobal("fetch", fetchMock);

    const listed = await mcp("tools/call", {
      name: "cw_get_invoice_expenses",
      arguments: { invoiceId: 42 },
    });

    expect(JSON.parse(toolText(listed))).toEqual(entries);
    expect(calledGet(fetchMock)).toEqual({
      method: "GET",
      path: "/v4_6_release/apis/3.0/expense/entries",
      conditions: "invoice/id = 42",
      page: "1",
      pageSize: "25",
      orderBy: null,
    });
  });
});
