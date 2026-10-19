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

async function mcp<T = ToolResult>(method: string, params: unknown): Promise<{ result: T }> {
  const response = await worker.fetch(new Request("http://worker.local/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), { AUTH_MODE: "gateway" });
  expect(response.status).toBe(200);
  return await response.json() as { result: T };
}

async function call(name: string, args: unknown): Promise<ToolResult> {
  return (await mcp("tools/call", { name, arguments: args })).result;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("ticket configuration tools", () => {
  it("registers both tools and their input schemas", async () => {
    const { result } = await mcp<{ tools: { name: string; inputSchema: {
      required: string[];
      properties: Record<string, unknown>;
    } }[] }>("tools/list", {});
    const tools = result.tools;
    expect(tools).toHaveLength(83);
    const get = tools.find((tool) => tool.name === "cw_get_ticket_configurations")!;
    const update = tools.find((tool) => tool.name === "cw_update_ticket_configurations")!;
    expect(get.inputSchema.required).toEqual(["id"]);
    expect(Object.keys(get.inputSchema.properties)).toEqual(["id", "page", "pageSize", "conditions", "orderBy"]);
    expect(get.inputSchema.properties.pageSize).toMatchObject({ type: "integer", maximum: 1000 });
    expect(update.inputSchema.required).toEqual(["id", "operations"]);
    expect(update.inputSchema.properties.operations).toMatchObject({
      type: "array", minItems: 1,
      items: { required: ["action", "configurationId"], properties: {
        action: { enum: ["add", "remove"] }, configurationId: { type: "integer" },
      } },
    });
  });

  it("lists references unchanged with default pagination", async () => {
    const references = [{ id: 123, deviceIdentifier: "server-01", _info: { configuration_href: "example" } }];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(references));
    vi.stubGlobal("fetch", fetchMock);
    const result = await call("cw_get_ticket_configurations", { id: 77 });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual(references);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).pathname).toBe("/v4_6_release/apis/3.0/service/tickets/77/configurations");
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ page: "1", pageSize: "25" });
    expect(init.method).toBe("GET");
  });

  it("forwards explicit paging, conditions, and ordering and preserves empty lists", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const result = await call("cw_get_ticket_configurations", {
      id: 77, page: 2, pageSize: 1000, conditions: "id > 5", orderBy: "id asc",
    });
    expect(JSON.parse(result.content[0].text)).toEqual([]);
    expect(Object.fromEntries(new URL(fetchMock.mock.calls[0][0]).searchParams)).toEqual({
      page: "2", pageSize: "1000", conditions: "id > 5", orderBy: "id asc",
    });
  });

  it("executes mixed changes in order, including repeated IDs, and handles 204", async () => {
    const configuration = { id: 123, deviceIdentifier: "server-01" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(configuration, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(configuration, 201));
    vi.stubGlobal("fetch", fetchMock);
    const operations = [
      { action: "add", configurationId: 123 },
      { action: "remove", configurationId: 123 },
      { action: "add", configurationId: 123 },
    ];
    const result = await call("cw_update_ticket_configurations", { id: 77, operations });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({ ticketId: 77, success: true, results: [
      { ...operations[0], success: true, configuration },
      { ...operations[1], success: true },
      { ...operations[2], success: true, configuration },
    ] });
    expect(fetchMock.mock.calls.map(([url, init]) => ({
      path: new URL(url).pathname, method: init.method, body: init.body,
    }))).toEqual([
      { path: "/v4_6_release/apis/3.0/service/tickets/77/configurations", method: "POST", body: '{"id":123}' },
      { path: "/v4_6_release/apis/3.0/service/tickets/77/configurations/123", method: "DELETE", body: undefined },
      { path: "/v4_6_release/apis/3.0/service/tickets/77/configurations", method: "POST", body: '{"id":123}' },
    ]);
  });

  it.each([
    { action: "add", status: 409, message: "Already associated" },
    { action: "remove", status: 404, message: "Association not found" },
  ])("continues after $action fails with $status and reports all outcomes", async ({ action, status, message }) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ message }, status))
      .mockResolvedValueOnce(jsonResponse({ id: 789 }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const result = await call("cw_update_ticket_configurations", { id: 77, operations: [
      { action: "remove", configurationId: 456 },
      { action, configurationId: 123 },
      { action: "add", configurationId: 789 },
    ] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ ticketId: 77, success: false, results: [
      { action: "remove", configurationId: 456, success: true },
      { action, configurationId: 123, success: false, error: expect.stringContaining(`returned ${status}`) },
      { action: "add", configurationId: 789, success: true, configuration: { id: 789 } },
    ] });
  });

  it("reports a listing API failure through MCP", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "Forbidden" }, 403)));
    const result = await call("cw_get_ticket_configurations", { id: 77 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("returned 403");
  });

  const invalidInputs = [
    ...[0, -1, 1.5, "77"].flatMap((id) => [
      { name: "cw_get_ticket_configurations", args: { id } },
      { name: "cw_update_ticket_configurations", args: { id, operations: [{ action: "add", configurationId: 123 }] } },
    ]),
    ...[0, -1, 1.5].map((page) => ({ name: "cw_get_ticket_configurations", args: { id: 77, page } })),
    ...[0, -1, 1.5, 1001].map((pageSize) => ({ name: "cw_get_ticket_configurations", args: { id: 77, pageSize } })),
    ...[0, -1, 1.5, "123"].map((configurationId) => ({
      name: "cw_update_ticket_configurations", args: { id: 77, operations: [{ action: "add", configurationId }] },
    })),
    { name: "cw_update_ticket_configurations", args: { id: 77, operations: [] } },
    { name: "cw_update_ticket_configurations", args: { id: 77, operations: [{ action: "replace", configurationId: 123 }] } },
    { name: "cw_update_ticket_configurations", args: { id: 77, operations: [
      { action: "add", configurationId: 123 }, { action: "remove", configurationId: 0 },
    ] } },
  ];

  it.each(invalidInputs)("rejects invalid input before HTTP: $name $args", async ({ name, args }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
