/**
 * cw_update_agreement_addition / cw_create_agreement_addition: JSON Patch
 * and create tools for agreement additions (recurring line items), plus the
 * update tool's dryRun preview mode.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";
import { applyPatchLocally } from "../tools/agreements.js";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyPatchLocally", () => {
  it("replaces, adds, and removes flat fields", () => {
    const result = applyPatchLocally(
      { id: 1, quantity: 5, billCustomer: "Billable" },
      [
        { op: "replace", path: "quantity", value: 12 },
        { op: "add", path: "cancelledDate", value: "2026-10-01" },
        { op: "remove", path: "billCustomer" },
      ],
    );
    expect(result).toEqual({ id: 1, quantity: 12, cancelledDate: "2026-10-01" });
  });

  it("does not mutate the input record", () => {
    const input = { id: 1, quantity: 5 };
    applyPatchLocally(input, [{ op: "replace", path: "quantity", value: 99 }]);
    expect(input.quantity).toBe(5);
  });
});

describe("agreement addition tools", () => {
  it("exposes cw_update_agreement_addition and cw_create_agreement_addition", async () => {
    const body = await mcp("tools/list", {});
    const tools = (body.result as { tools: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] }).tools;
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(byName.cw_update_agreement_addition).toBeDefined();
    expect(byName.cw_update_agreement_addition.inputSchema?.properties).toHaveProperty("dryRun");
    expect(byName.cw_create_agreement_addition).toBeDefined();
    expect(byName.cw_create_agreement_addition.inputSchema?.properties).toHaveProperty("billCustomer");
  });

  it("patches an addition (weekly seat-count reconciliation)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fakeResponse({ id: 9, quantity: 12 }));
    vi.stubGlobal("fetch", fetchMock);

    const updated = await mcp("tools/call", {
      name: "cw_update_agreement_addition",
      arguments: {
        agreementId: 4,
        additionId: 9,
        operations: [{ op: "replace", path: "quantity", value: 12 }],
      },
    });

    expect(JSON.parse(toolText(updated))).toEqual({ id: 9, quantity: 12 });
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toContain("/finance/agreements/4/additions/9");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual([{ op: "replace", path: "quantity", value: 12 }]);
  });

  it("dryRun fetches the current addition, previews the patch, and makes no write", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      fakeResponse({ id: 9, quantity: 5, billCustomer: "Billable" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const previewed = await mcp("tools/call", {
      name: "cw_update_agreement_addition",
      arguments: {
        agreementId: 4,
        additionId: 9,
        operations: [{ op: "replace", path: "quantity", value: 12 }],
        dryRun: true,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method?: string }];
    expect(url).toContain("/finance/agreements/4/additions/9");
    expect(init.method ?? "GET").toBe("GET");
    expect(JSON.parse(toolText(previewed))).toEqual({
      dryRun: true,
      saved: false,
      preview: { id: 9, quantity: 12, billCustomer: "Billable" },
    });
  });

  it("creates an addition", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      fakeResponse({ id: 15, product: { id: 200 }, billCustomer: "Billable", quantity: 3 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const created = await mcp("tools/call", {
      name: "cw_create_agreement_addition",
      arguments: {
        agreementId: 4,
        productId: 200,
        billCustomer: "Billable",
        quantity: 3,
      },
    });

    expect(JSON.parse(toolText(created))).toMatchObject({ id: 15 });
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toContain("/finance/agreements/4/additions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      product: { id: 200 },
      billCustomer: "Billable",
      quantity: 3,
    });
  });
});
