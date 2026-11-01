import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMemberPolicy,
  describeMemberPolicy,
  memberOverrideNotice,
  parseForceFlag,
  parseMemberId,
  resolveMemberId,
} from "../member-policy.js";
import { buildConfig, resolveGatewayConfig } from "../mcp-server.js";
import { CwManageClient } from "../api-client.js";
import worker from "../worker.js";

describe("member-policy parsing", () => {
  it("parses positive integers only", () => {
    expect(parseMemberId("123")).toBe(123);
    expect(parseMemberId(" 7 ")).toBe(7);
    expect(parseMemberId("0")).toBeUndefined();
    expect(parseMemberId("-4")).toBeUndefined();
    expect(parseMemberId("12a")).toBeUndefined();
    expect(parseMemberId("")).toBeUndefined();
    expect(parseMemberId(undefined)).toBeUndefined();
  });

  it("parses force flags", () => {
    expect(parseForceFlag("true")).toBe(true);
    expect(parseForceFlag("TRUE")).toBe(true);
    expect(parseForceFlag("1")).toBe(true);
    expect(parseForceFlag("yes")).toBe(true);
    expect(parseForceFlag("false")).toBe(false);
    expect(parseForceFlag(undefined)).toBe(false);
  });

  it("drops a force flag with no member id", () => {
    expect(buildMemberPolicy(undefined, "true")).toBeUndefined();
    expect(buildMemberPolicy("abc", "true")).toBeUndefined();
  });
});

describe("resolveMemberId", () => {
  it("passes the caller value through with no policy", () => {
    expect(resolveMemberId(undefined, 55)).toEqual({ memberId: 55, overrode: false });
    expect(resolveMemberId(undefined, undefined)).toEqual({ memberId: undefined, overrode: false });
  });

  it("fills in the default only when the caller omitted it", () => {
    const p = buildMemberPolicy("100", "false");
    expect(resolveMemberId(p, undefined)).toEqual({ memberId: 100, overrode: false });
    expect(resolveMemberId(p, 55)).toEqual({ memberId: 55, overrode: false });
  });

  it("forces the configured id and reports the override", () => {
    const p = buildMemberPolicy("100", "true");
    expect(resolveMemberId(p, undefined)).toEqual({ memberId: 100, overrode: false });
    expect(resolveMemberId(p, 100)).toEqual({ memberId: 100, overrode: false });
    expect(resolveMemberId(p, 55)).toEqual({ memberId: 100, overrode: true });
  });

  it("describes itself", () => {
    expect(describeMemberPolicy(undefined)).toMatch(/no server member policy/);
    expect(describeMemberPolicy(buildMemberPolicy("9", "false"))).toMatch(/defaults memberId to 9/);
    expect(describeMemberPolicy(buildMemberPolicy("9", "true"))).toMatch(/forces member id 9/);
  });
});

describe("transport plumbing", () => {
  it("gateway headers populate the policy", () => {
    const headers: Record<string, string> = {
      "x-cw-company-id": "ck",
      "x-cw-public-key": "pub",
      "x-cw-private-key": "priv",
      "x-cw-client-id": "cid",
      "x-cw-member-id": "321",
      "x-cw-force-member-id": "true",
    };
    const { config, error } = resolveGatewayConfig((n) => headers[n]);
    expect(error).toBeUndefined();
    expect(config?.memberPolicy).toEqual({ memberId: 321, forced: true });
  });

  it("gateway without member headers has no policy", () => {
    const headers: Record<string, string> = {
      "x-cw-company-id": "ck",
      "x-cw-public-key": "pub",
      "x-cw-private-key": "priv",
      "x-cw-client-id": "cid",
    };
    const { config } = resolveGatewayConfig((n) => headers[n]);
    expect(config?.memberPolicy).toBeUndefined();
    expect("memberPolicy" in (config ?? {})).toBe(false);
  });

  it("buildConfig carries the policy onto the client", () => {
    const { config } = buildConfig("ck", "pub", "priv", "cid", undefined, buildMemberPolicy("42", "1"));
    const client = new CwManageClient(config!);
    expect(client.memberPolicy).toEqual({ memberId: 42, forced: true });
  });

  it("client defaults to an empty policy", () => {
    const { config } = buildConfig("ck", "pub", "priv", "cid");
    const client = new CwManageClient(config!);
    expect(client.memberPolicy).toEqual({ forced: false });
  });
});

describe("write tools send the policy's member id", () => {
  const BASE_HEADERS = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "X-CW-Company-Id": "acme",
    "X-CW-Public-Key": "pub",
    "X-CW-Private-Key": "priv",
    "X-CW-Client-Id": "client-guid",
  };
  const FORCED = { "X-CW-Member-Id": "100", "X-CW-Force-Member-Id": "true" };

  type ToolResult = { content: { text: string }[]; isError?: boolean };

  function stubManage(response: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(response)),
      json: () => Promise.resolve(response),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    return JSON.parse(init.body) as Record<string, unknown>;
  }

  async function callTool(name: string, args: unknown, headers: Record<string, string>): Promise<ToolResult> {
    const res = await worker.fetch(
      new Request("http://worker.local/mcp", {
        method: "POST",
        headers: { ...BASE_HEADERS, ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
      { AUTH_MODE: "gateway" },
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: ToolResult }).result;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forces the ticket note author and says so", async () => {
    const fetchMock = stubManage({ id: 1, text: "done" });
    const result = await callTool("cw_add_ticket_note", { id: 7, text: "done", memberId: 55 }, FORCED);
    expect(sentBody(fetchMock).member).toEqual({ id: 100 });
    expect(result.content[1]?.text).toBe(memberOverrideNotice(55, 100));
  });

  it("forces the project note author with no notice when the caller passed none", async () => {
    const fetchMock = stubManage({ id: 2, text: "done" });
    const result = await callTool("cw_add_project_ticket_note", { id: 8, text: "done" }, FORCED);
    expect(sentBody(fetchMock).member).toEqual({ id: 100 });
    expect(result.content).toHaveLength(1);
  });

  it("forces the time entry member and keeps the entry JSON first", async () => {
    const fetchMock = stubManage({ id: 3 });
    const result = await callTool(
      "cw_create_time_entry",
      { chargeToType: "ChargeCode", chargeToId: 9, memberId: 55, timeStart: "2026-10-22T13:00:00Z", actualHours: 1 },
      FORCED,
    );
    expect(sentBody(fetchMock).member).toEqual({ id: 100 });
    expect(JSON.parse(result.content[0]!.text)).toEqual({ id: 3 });
    expect(result.content[1]?.text).toBe(memberOverrideNotice(55, 100));
  });

  it("lets the caller's member id win when not forced", async () => {
    const fetchMock = stubManage({ id: 4, text: "done" });
    const result = await callTool("cw_add_ticket_note", { id: 7, text: "done", memberId: 55 }, { "X-CW-Member-Id": "100" });
    expect(sentBody(fetchMock).member).toEqual({ id: 55 });
    expect(result.content).toHaveLength(1);
  });

  it("refuses a time entry with no member id and no policy, without calling Manage", async () => {
    const fetchMock = stubManage({ id: 5 });
    const result = await callTool(
      "cw_create_time_entry",
      { chargeToType: "ChargeCode", chargeToId: 9, timeStart: "2026-10-22T13:00:00Z", actualHours: 1 },
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/memberId is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
