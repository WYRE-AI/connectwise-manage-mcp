import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";

const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "X-CW-Company-Id": "example",
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

const CUSTOM_FILTER = 'caption="Contract Type" AND value="Managed"';
const CONDITIONS = "id > 0";
const cases: [string, Record<string, unknown>, string][] = [
  ["cw_search_tickets", {}, "/service/tickets"],
  ["cw_search_projects", {}, "/project/projects"],
  ["cw_search_project_tickets", {}, "/project/tickets"],
  ["cw_search_companies", {}, "/company/companies"],
  ["cw_search_contacts", {}, "/company/contacts"],
  ["cw_search_configurations", {}, "/company/configurations"],
  ["cw_search_opportunities", {}, "/sales/opportunities"],
  ["cw_search_activities", {}, "/sales/activities"],
  ["cw_search_agreements", {}, "/finance/agreements"],
  ["cw_search_invoices", {}, "/finance/invoices"],
  ["cw_search_purchase_orders", {}, "/procurement/purchaseorders"],
  ["cw_get_purchase_order_items", { purchaseOrderId: 77 }, "/procurement/purchaseorders/77/lineitems"],
  ["cw_search_procurement_products", {}, "/procurement/products"],
  ["cw_search_sales_orders", {}, "/sales/orders"],
  ["cw_get_sales_order_products", { salesOrderId: 42 }, "/procurement/products"],
  ["cw_search_catalog_items", {}, "/procurement/catalog"],
  ["cw_search_members", {}, "/system/members"],
  ["cw_search_time_entries", {}, "/time/entries"],
];

afterEach(() => vi.unstubAllGlobals());

describe("custom field conditions", () => {
  describe.each(cases)("%s", (name, args, path) => {
    it("passes custom field conditions unchanged alongside conditions", async () => {
      const url = await callAndCaptureUrl(name, {
        ...args,
        conditions: CONDITIONS,
        customFieldConditions: CUSTOM_FILTER,
      });
      expect(url.origin + url.pathname).toBe(`${API_BASE}${path}`);
      expect(url.searchParams.get("customFieldConditions")).toBe(CUSTOM_FILTER);
      expect(url.searchParams.get("conditions")).toBe(
        name === "cw_get_sales_order_products"
          ? `salesOrder/id=42 and (${CONDITIONS})`
          : name === "cw_search_projects"
            ? `closedFlag = false and (${CONDITIONS})`
            : CONDITIONS,
      );
    });

    it.each([undefined, ""])("omits an unset filter (%s)", async (filter) => {
      const url = await callAndCaptureUrl(name, {
        ...args,
        ...(filter === undefined ? {} : { customFieldConditions: filter }),
      });
      expect(url.searchParams.has("customFieldConditions")).toBe(false);
    });
  });

  it("advertises the optional string immediately after conditions only on the intended tools", async () => {
    const body = (await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    })) as { result: { tools: { name: string; inputSchema: {
      properties: Record<string, { type?: string; description?: string }>;
      required?: string[];
    } }[] } };
    const tools = body.result.tools;
    const names = cases.map(([name]) => name);
    expect(tools.filter((tool) => "customFieldConditions" in tool.inputSchema.properties)
      .map((tool) => tool.name).sort()).toEqual([...names].sort());
    for (const name of names) {
      const schema = tools.find((tool) => tool.name === name)!.inputSchema;
      const keys = Object.keys(schema.properties);
      expect(keys[keys.indexOf("conditions") + 1]).toBe("customFieldConditions");
      expect(schema.properties.customFieldConditions.type).toBe("string");
      expect(schema.required ?? []).not.toContain("customFieldConditions");
    }
    for (const name of ["cw_list_boards", "cw_search_schedule_entries", "cw_search_agreement_recaps"]) {
      expect(tools.find((tool) => tool.name === name)!.inputSchema.properties)
        .not.toHaveProperty("customFieldConditions");
    }
  });

  it("retains the sales order scope without additional conditions", async () => {
    const url = await callAndCaptureUrl("cw_get_sales_order_products", {
      salesOrderId: 42,
      customFieldConditions: CUSTOM_FILTER,
    });
    expect(url.searchParams.get("conditions")).toBe("salesOrder/id=42");
    expect(url.searchParams.get("customFieldConditions")).toBe(CUSTOM_FILTER);
  });

  it("rewrites contact conditions while leaving the custom filter untouched", async () => {
    const filter = ' caption="Contract Type" AND value="Member\'s Plan" ';
    const url = await callAndCaptureUrl("cw_search_contacts", {
      conditions: "name = 'Ada'",
      customFieldConditions: filter,
    });
    expect(url.searchParams.get("conditions")).toBe('(firstName = "Ada" or lastName = "Ada")');
    expect(url.searchParams.get("customFieldConditions")).toBe(filter);
  });

  it.each([
    'caption="Renewal Date" AND value > [2026-01-01T00:00:00Z]',
    'caption="Contract Type" AND value != null',
  ])("passes date and null expressions unchanged: %s", async (filter) => {
    const url = await callAndCaptureUrl("cw_search_tickets", { customFieldConditions: filter });
    expect(url.searchParams.get("customFieldConditions")).toBe(filter);
  });
});
