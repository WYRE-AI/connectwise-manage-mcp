/**
 * cw_update_invoice: path allow-list, dryRun preview (no write), PATCH
 * pass-through, error pass-through, and the single retry (429 always; 5xx only
 * when every PATCH operation is replace).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";
import { CwApiError } from "../api-client.js";
import {
  applyInvoicePatchLocally,
  validateInvoiceOperations,
  withSingleRetry,
} from "../tools/invoices.js";

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

type ToolResult = { content?: { text?: string }[]; isError?: boolean };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateInvoiceOperations", () => {
  it("accepts allowed paths with or without a leading slash and normalizes them", () => {
    const ops = validateInvoiceOperations([
      { op: "replace", path: "/status/id", value: 11 },
      { op: "replace", path: "status", value: { id: 7 } },
      { op: "replace", path: "customerPO", value: "PO-1" },
      { op: "replace", path: "/billToSite/id", value: 42 },
      { op: "remove", path: "internalNotes" },
    ]);
    expect(ops.map((o) => o.path)).toEqual([
      "status/id",
      "status",
      "customerPO",
      "billingSite/id",
      "internalNotes",
    ]);
  });

  it("rejects custom fields, payment fields, and unknown paths", () => {
    expect(() =>
      validateInvoiceOperations([{ op: "replace", path: "customFields", value: [] }]),
    ).toThrow(/not allowed/);
    expect(() =>
      validateInvoiceOperations([{ op: "replace", path: "/payments", value: [] }]),
    ).toThrow(/not allowed/);
    expect(() =>
      validateInvoiceOperations([{ op: "replace", path: "total", value: 0 }]),
    ).toThrow(/not allowed/);
  });

  it("rejects billToContact with a pointer to attention (not a Manage invoice field)", () => {
    expect(() =>
      validateInvoiceOperations([{ op: "replace", path: "billToContact/id", value: 5 }]),
    ).toThrow(/no billToContact field/);
  });

  it("rejects malformed status values and removing status", () => {
    expect(() =>
      validateInvoiceOperations([{ op: "replace", path: "status/id", value: "Approved" }]),
    ).toThrow(/positive integer/);
    expect(() =>
      validateInvoiceOperations([{ op: "replace", path: "status", value: 7 }]),
    ).toThrow(/\{ "id": 7 \}/);
    expect(() => validateInvoiceOperations([{ op: "remove", path: "status" }])).toThrow(
      /cannot be removed/,
    );
  });
});

describe("applyInvoicePatchLocally", () => {
  it("handles nested status/id and whole-object replaces without mutating input", () => {
    const input = { id: 5, status: { id: 1, name: "New" }, reference: "A", attention: "x" };
    const out = applyInvoicePatchLocally(input, [
      { op: "replace", path: "status/id", value: 11 },
      { op: "replace", path: "billingSite", value: { id: 3 } },
      { op: "remove", path: "attention" },
    ]);
    expect(out).toEqual({ id: 5, status: { id: 11, name: "New" }, reference: "A", billingSite: { id: 3 } });
    expect(input.status.id).toBe(1);
    expect(input.attention).toBe("x");
  });
});

describe("withSingleRetry", () => {
  it("retries exactly once on 429 and 5xx", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new CwApiError("PATCH", "/x", 503, "busy"))
      .mockResolvedValueOnce("ok");
    await expect(withSingleRetry(fn, 0)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);

    const fn2 = vi.fn().mockRejectedValue(new CwApiError("PATCH", "/x", 429, "slow down"));
    await expect(withSingleRetry(fn2, 0)).rejects.toThrow(/429/);
    expect(fn2).toHaveBeenCalledTimes(2);
  });

  it("never retries other 4xx", async () => {
    for (const status of [400, 401, 403, 404, 409]) {
      const fn = vi.fn().mockRejectedValue(new CwApiError("PATCH", "/x", status, "nope"));
      await expect(withSingleRetry(fn, 0)).rejects.toThrow(String(status));
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });
});

describe("cw_update_invoice tool", () => {
  it("is listed next to search/get invoice with id, operations, dryRun", async () => {
    const body = await mcp("tools/list", {});
    const tools = (body.result as { tools: { name: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }[] }).tools;
    const names = tools.map((t) => t.name);
    const i = names.indexOf("cw_update_invoice");
    expect(i).toBeGreaterThan(-1);
    expect(names[i - 1]).toBe("cw_get_invoice");
    const tool = tools[i];
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(Object.keys(tool.inputSchema?.properties ?? {})).toEqual(["id", "operations", "dryRun"]);
    expect(tool.inputSchema?.required).toEqual(["id", "operations"]);
    expect(tool.description).toMatch(/Ready to Send = 11/);
    expect(tool.description).toMatch(/5xx is retried once only when every operation is replace/);
    expect(tool.description).toMatch(/Invoices: Edit/);
  });

  it("PATCHes /finance/invoices/{id} with normalized operations", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fakeResponse({ id: 77, status: { id: 11, name: "Ready to Send" } }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await mcp("tools/call", {
      name: "cw_update_invoice",
      arguments: {
        id: 77,
        operations: [
          { op: "replace", path: "/status/id", value: 11 },
          { op: "replace", path: "billToSite/id", value: 42 },
        ],
      },
    });
    const result = res.result as ToolResult;
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content?.[0]?.text ?? "")).toEqual({ id: 77, status: { id: 11, name: "Ready to Send" } });
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toContain("/finance/invoices/77");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual([
      { op: "replace", path: "/status/id", value: 11 },
      { op: "replace", path: "/billingSite/id", value: 42 },
    ]);
  });

  it("rejects a disallowed path without calling Manage", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await mcp("tools/call", {
      name: "cw_update_invoice",
      arguments: { id: 77, operations: [{ op: "replace", path: "customFields", value: [] }] },
    });
    const result = res.result as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/not allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dryRun GETs the invoice, previews the patch, and makes no write", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fakeResponse({ id: 77, status: { id: 1, name: "New" } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await mcp("tools/call", {
      name: "cw_update_invoice",
      arguments: { id: 77, operations: [{ op: "replace", path: "status/id", value: 7 }], dryRun: true },
    });
    const result = res.result as ToolResult;
    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method?: string }];
    expect(url).toContain("/finance/invoices/77");
    expect(init.method ?? "GET").toBe("GET");
    expect(JSON.parse(result.content?.[0]?.text ?? "")).toMatchObject({
      dryRun: true,
      saved: false,
      operations: [{ op: "replace", path: "/status/id", value: 7 }],
      preview: { id: 77, status: { id: 7, name: "New" } },
    });
  });

  it("retries a replace-only PATCH once on 503", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ message: "unavailable" }, 503))
      .mockResolvedValueOnce(fakeResponse({ id: 77, status: { id: 11 } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await mcp("tools/call", {
      name: "cw_update_invoice",
      arguments: { id: 77, operations: [{ op: "replace", path: "status/id", value: 11 }] },
    });
    const result = res.result as ToolResult;
    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every((call) => (call[1] as { method: string }).method === "PATCH")).toBe(true);
  });

  it("does not retry a remove PATCH on 503", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ message: "unavailable" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    const res = await mcp("tools/call", {
      name: "cw_update_invoice",
      arguments: { id: 77, operations: [{ op: "remove", path: "attention" }] },
    });
    const result = res.result as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries both replace and remove once on 429", async () => {
    for (const operations of [
      [{ op: "replace", path: "status/id", value: 11 }],
      [{ op: "remove", path: "attention" }],
    ]) {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse({ message: "slow down" }, 429))
        .mockResolvedValueOnce(fakeResponse({ id: 77 }));
      vi.stubGlobal("fetch", fetchMock);
      const res = await mcp("tools/call", {
        name: "cw_update_invoice",
        arguments: { id: 77, operations },
      });
      const result = res.result as ToolResult;
      expect(result.isError).not.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("passes a Manage 403 through with its message and does not retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ code: "Forbidden", message: "Invoices Edit required" }, 403));
    vi.stubGlobal("fetch", fetchMock);
    const res = await mcp("tools/call", {
      name: "cw_update_invoice",
      arguments: { id: 77, operations: [{ op: "replace", path: "status/id", value: 7 }] },
    });
    const result = res.result as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/403.*Invoices Edit required/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
