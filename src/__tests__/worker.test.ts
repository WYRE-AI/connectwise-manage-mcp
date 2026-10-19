/**
 * Tests for the Cloudflare Workers entrypoint.
 *
 * Drives the exported `fetch` handler directly with Web Standard Request objects
 * (available natively in Node 18+), exercising the same WebStandardStreamableHTTP
 * transport the Worker uses in production.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import worker, { type Env } from "../worker.js";

const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

async function mcp(body: unknown, env: Env = {}): Promise<Response> {
  return worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(body),
    }),
    env,
  );
}

const GATEWAY_HEADERS = {
  ...MCP_HEADERS,
  "X-CW-Company-Id": "acme",
  "X-CW-Public-Key": "pub",
  "X-CW-Private-Key": "priv",
  "X-CW-Client-Id": "client-guid",
};

describe("Cloudflare Worker entrypoint", () => {
  it("serves a shallow health probe", async () => {
    const res = await worker.fetch(new Request("http://worker.local/health"), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers CORS preflight", async () => {
    const res = await worker.fetch(
      new Request("http://worker.local/mcp", { method: "OPTIONS" }),
      {},
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("404s unknown paths", async () => {
    const res = await worker.fetch(new Request("http://worker.local/nope"), {});
    expect(res.status).toBe(404);
  });

  it("handles MCP initialize", async () => {
    const res = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(body.result?.serverInfo?.name).toBe("connectwise-manage-mcp");
  });

  it("lists the diagnostic tool when no credentials are configured", async () => {
    const res = await mcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { tools?: { name: string }[] };
    };
    const names = (body.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("cw_test_connection");
  });

  it("lists the full tool set when credentials are supplied via gateway headers", async () => {
    const res = await worker.fetch(
      new Request("http://worker.local/mcp", {
        method: "POST",
        headers: GATEWAY_HEADERS,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
          params: {},
        }),
      }),
      { AUTH_MODE: "gateway" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { tools?: { name: string }[] };
    };
    const names = (body.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("cw_search_tickets");
    expect(names).toContain("cw_get_ticket");
    expect(names.length).toBeGreaterThan(10);
  });

  it("returns a graceful error for a credential-requiring tool when unconfigured", async () => {
    const res = await mcp({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "cw_test_connection", arguments: {} },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/credentials/i);
  });

  it("rejects /mcp in gateway mode without credential headers", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "cw_search_tickets", arguments: {} },
      },
      { AUTH_MODE: "gateway" },
    );
    expect(res.status).toBe(401);
  });

  describe("env mode caller auth", () => {
    const CREDS: Env = {
      CW_MANAGE_COMPANY_ID: "acme",
      CW_MANAGE_PUBLIC_KEY: "pub",
      CW_MANAGE_PRIVATE_KEY: "priv",
      CW_MANAGE_CLIENT_ID: "client-guid",
    };
    const call = {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "cw_create_schedule_entry", arguments: {} },
    };

    async function withAuth(env: Env, authorization?: string, body: unknown = call): Promise<Response> {
      return worker.fetch(
        new Request("http://worker.local/mcp", {
          method: "POST",
          headers: authorization ? { ...MCP_HEADERS, Authorization: authorization } : MCP_HEADERS,
          body: JSON.stringify(body),
        }),
        env,
      );
    }

    afterEach(() => vi.unstubAllGlobals());

    it("fails closed when secrets are set but MCP_BEARER_TOKEN is not", async () => {
      expect((await withAuth(CREDS)).status).toBe(503);
    });

    it("rejects a missing or wrong bearer token", async () => {
      const env = { ...CREDS, MCP_BEARER_TOKEN: "s3cret" };
      expect((await withAuth(env)).status).toBe(401);
      expect((await withAuth(env, "Bearer nope")).status).toBe(401);
    });

    it("lets a caller with the right bearer token through", async () => {
      const created = { id: 42, objectId: 100, member: { id: 7 } };
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(created), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const env = { ...CREDS, MCP_BEARER_TOKEN: "s3cret" };
      const res = await withAuth(env, "Bearer s3cret", {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "cw_create_schedule_entry",
          arguments: {
            objectId: 100,
            typeId: 4,
            memberId: 7,
            dateStart: "2026-10-08T02:00:00Z",
            dateEnd: "2026-10-08T03:00:00Z",
          },
        },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        jsonrpc?: string;
        id?: number;
        error?: unknown;
        result?: { isError?: boolean; content?: { text: string }[] };
      };
      expect(body).toMatchObject({ jsonrpc: "2.0", id: 9 });
      expect(body.error).toBeUndefined();
      expect(body.result).toBeDefined();
      expect(body.result?.isError).not.toBe(true);
      expect(JSON.parse(body.result!.content![0].text)).toEqual(created);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, { method: string }];
      expect(new URL(url).pathname).toBe("/v4_6_release/apis/3.0/schedule/entries");
      expect(init.method).toBe("POST");
    });
  });
});
