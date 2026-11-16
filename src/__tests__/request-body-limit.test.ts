/**
 * GHSA-f897-62hf-6gxq (WYREAI-454): /mcp request body cap.
 * The cap runs after the X-Gateway-S2S check, never before it.
 */

import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startHttpTransport } from "../index.js";
import { MAX_REQUEST_BODY_BYTES } from "../input-limits.js";

const S2S_SECRET = "s2s-body-limit-test-5d1e";
const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "AUTH_MODE",
  "MCP_OAUTH_ENABLED",
] as const;
const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

const servers: HttpServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function mintS2sHeader(secret: string): string {
  const message = `t=${Math.floor(Date.now() / 1000)}`;
  return `${message},v1=${createHmac("sha256", secret).update(message).digest("hex")}`;
}

async function start(authMode: "env" | "gateway" = "env"): Promise<number> {
  process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.MCP_OAUTH_ENABLED;
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  process.env.MCP_HTTP_PORT = "0";
  process.env.AUTH_MODE = authMode;
  const server = await startHttpTransport();
  servers.push(server);
  const info = server.address();
  if (!info || typeof info === "string")
    throw new Error("expected a TCP address");
  return info.port;
}

/**
 * Send only the request head with an oversized Content-Length and resolve with
 * the status. The status decision is made from headers, and not streaming the
 * body avoids a racy ECONNRESET when the server answers before reading it.
 */
function headersOnly(
  port: number,
  headers: Record<string, string>,
  method: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      method,
      path: "/mcp",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
        ...headers,
      },
    });
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.on("response", (res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
      req.destroy();
    });
    // A reset after the status arrived is a no-op: the promise already resolved.
    req.on("error", reject);
    req.flushHeaders();
  });
}

function post(
  port: number,
  headers: Record<string, string>,
  body: string,
  method = "POST",
  chunked = false,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // The server may answer and reset the socket before the whole body is
    // flushed. Once a status line has arrived, a late reset still counts as
    // that response rather than a test failure.
    let status: number | undefined;
    const chunks: Buffer[] = [];
    const done = () =>
      resolve({
        status: status ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      });
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: "/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        status = res.statusCode ?? 0;
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", done);
        res.on("error", done);
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.on("error", (err) => (status === undefined ? reject(err) : done()));
    if (chunked) {
      // No Content-Length: Node falls back to Transfer-Encoding: chunked.
      const half = Math.floor(body.length / 2);
      req.write(body.slice(0, half));
      req.end(body.slice(half));
    } else {
      req.end(body);
    }
  });
}

const oversized = "x".repeat(262144 + 1);

describe("/mcp request body cap", () => {
  it("returns 413 with a JSON-RPC error after a valid S2S check", async () => {
    const port = await start();
    const res = await post(
      port,
      { "x-gateway-s2s": mintS2sHeader(S2S_SECRET) },
      oversized,
    );
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Request body exceeds 262144 bytes" },
      id: null,
    });
  });

  it("returns 401, not 413, when the S2S header is missing or invalid", async () => {
    const port = await start();
    expect((await post(port, {}, oversized)).status).toBe(401);
    const invalid = await post(
      port,
      { "x-gateway-s2s": mintS2sHeader("wrong") },
      oversized,
    );
    expect(invalid.status).toBe(401);
  });

  it("returns 413 for an oversized chunked body with no Content-Length", async () => {
    const port = await start();
    const res = await post(
      port,
      { "x-gateway-s2s": mintS2sHeader(S2S_SECRET) },
      oversized,
      "POST",
      true,
    );
    expect(res.status).toBe(413);
  });

  it("accepts a valid body of exactly the cap", async () => {
    const port = await start();
    const init = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    });
    const body = init + " ".repeat(262144 - Buffer.byteLength(init));
    expect(Buffer.byteLength(body)).toBe(262144);
    const res = await post(
      port,
      { "x-gateway-s2s": mintS2sHeader(S2S_SECRET) },
      body,
    );
    expect(res.status).toBe(200);
  });

  it("returns 405 for an oversized non-POST after a valid S2S check, 401 without it", async () => {
    const port = await start();
    const valid = { "x-gateway-s2s": mintS2sHeader(S2S_SECRET) };
    for (const method of ["GET", "DELETE"]) {
      expect(await headersOnly(port, valid, method)).toBe(405);
      expect(await headersOnly(port, {}, method)).toBe(401);
    }
  });

  it("returns 401, not 413, in gateway mode when credential headers are missing", async () => {
    const port = await start("gateway");
    const valid = { "x-gateway-s2s": mintS2sHeader(S2S_SECRET) };
    const res = await post(port, valid, oversized);
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error).toBe("Missing credentials");
    const withCreds = await post(
      port,
      {
        ...valid,
        "x-cw-company-id": "c",
        "x-cw-public-key": "p",
        "x-cw-private-key": "k",
        "x-cw-client-id": "i",
      },
      oversized,
    );
    expect(withCreds.status).toBe(413);
  });

  it("still serves a small initialize and tools/list", async () => {
    const port = await start();
    const headers = { "x-gateway-s2s": mintS2sHeader(S2S_SECRET) };
    const init = await post(
      port,
      headers,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      }),
    );
    expect(init.status).toBe(200);
    const list = await post(
      port,
      headers,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    );
    expect(list.status).toBe(200);
  });
});
