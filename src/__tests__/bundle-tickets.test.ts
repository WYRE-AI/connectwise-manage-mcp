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

async function rpc(method: string, params: unknown): Promise<unknown> {
  const response = await worker.fetch(new Request("http://worker.local/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), { AUTH_MODE: "gateway" });
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: unknown }).result;
}

async function call(name: string, args: unknown): Promise<ToolResult> {
  return (await rpc("tools/call", { name, arguments: args })) as ToolResult;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("cw_bundle_tickets (WYREAI-575)", () => {
  it("is annotated as a destructive write", async () => {
    const result = (await rpc("tools/list", {})) as {
      tools: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[];
    };
    const tool = result.tools.find((candidate) => candidate.name === "cw_bundle_tickets");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("attaches the de-duplicated children with one attachChildren call", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ id: 10 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await call("cw_bundle_tickets", { parentTicketId: 10, childTicketIds: [11, 12, 11] });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({
      parentTicketId: 10,
      success: true,
      childTicketIds: [11, 12],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).pathname).toBe("/v4_6_release/apis/3.0/service/tickets/10/attachChildren");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"childTicketIds":[11,12]}');
  });

  it("returns Manage's rejection as an error", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ message: "nope" }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const result = await call("cw_bundle_tickets", { parentTicketId: 10, childTicketIds: [11, 12] });
    expect(result.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text)).toEqual({
      parentTicketId: 10,
      success: false,
      childTicketIds: [11, 12],
      error: expect.stringContaining("returned 400"),
    });
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
