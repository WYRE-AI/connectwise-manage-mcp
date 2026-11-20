import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker.js";

const headers = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "X-CW-Company-Id": "acme",
  "X-CW-Public-Key": "pub",
  "X-CW-Private-Key": "priv",
  "X-CW-Client-Id": "client-guid",
};

interface ToolResult {
  content: { text: string }[];
  isError?: boolean;
}

async function call(name: string, args: unknown): Promise<ToolResult> {
  const response = await worker.fetch(new Request("http://worker.local/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), { AUTH_MODE: "gateway" });
  expect(response.status).toBe(200);
  return (await response.json() as { result: ToolResult }).result;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("cw_bundle_tickets (WYREAI-575)", () => {
  it("patches parentTicketId on each child, de-duplicating the list", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ id: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await call("cw_bundle_tickets", { parentTicketId: 10, childTicketIds: [11, 12, 11] });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({ parentTicketId: 10, success: true, results: [
      { childTicketId: 11, success: true },
      { childTicketId: 12, success: true },
    ] });
    expect(fetchMock.mock.calls.map(([url, init]) => ({
      path: new URL(url).pathname, method: init.method, body: init.body,
    }))).toEqual([11, 12].map((child) => ({
      path: `/v4_6_release/apis/3.0/service/tickets/${child}`,
      method: "PATCH",
      body: '[{"op":"replace","path":"parentTicketId","value":10}]',
    })));
  });

  it("continues after a child fails and reports every outcome", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: "nope" }, 404))
      .mockResolvedValueOnce(jsonResponse({ id: 12 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await call("cw_bundle_tickets", { parentTicketId: 10, childTicketIds: [11, 12] });
    expect(result.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.content[0].text)).toEqual({ parentTicketId: 10, success: false, results: [
      { childTicketId: 11, success: false, error: expect.stringContaining("returned 404") },
      { childTicketId: 12, success: true },
    ] });
  });

  it("refuses to bundle a ticket under itself without calling Manage", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await call("cw_bundle_tickets", { parentTicketId: 10, childTicketIds: [11, 10] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cannot be bundled under itself");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
