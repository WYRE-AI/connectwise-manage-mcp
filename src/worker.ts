/**
 * Cloudflare Workers entry point for the ConnectWise Manage MCP Server.
 *
 * Serves the full MCP server over the Streamable HTTP transport using the SDK's
 * Web Standard transport (Request/Response), which runs natively on Workers.
 * It reuses the exact same `createMcpServer()` factory as the stdio / Node HTTP
 * entrypoints (see `mcp-server.ts`), so there is no second tool implementation
 * to maintain.
 *
 * Credentials are resolved per request, in order:
 * 1. Gateway headers (when AUTH_MODE=gateway):
 *    - X-CW-Company-Id
 *    - X-CW-Public-Key
 *    - X-CW-Private-Key
 *    - X-CW-Client-Id
 *    - X-CW-Url (optional)
 * 2. Worker secrets / vars (env mode):
 *    - CW_MANAGE_COMPANY_ID
 *    - CW_MANAGE_PUBLIC_KEY
 *    - CW_MANAGE_PRIVATE_KEY
 *    - CW_MANAGE_CLIENT_ID
 *    - CW_MANAGE_URL (optional)
 *
 * `tools/list` and `initialize` work without credentials; only `tools/call`
 * requires them.
 *
 * Caller auth in env mode: once Worker secrets give this Worker a vendor
 * identity, every `/mcp` request must carry `Authorization: Bearer
 * <MCP_BEARER_TOKEN>`. If the secrets are set but MCP_BEARER_TOKEN is not,
 * `/mcp` fails closed (503) instead of exposing reads and schedule writes to
 * anyone who can reach the Worker. Gateway mode authenticates by the
 * per-request credential headers.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createMcpServer,
  resolveGatewayConfig,
  buildConfig,
  type CwManageConfig,
} from "./mcp-server.js";

export interface Env {
  CW_MANAGE_COMPANY_ID?: string;
  CW_MANAGE_PUBLIC_KEY?: string;
  CW_MANAGE_PRIVATE_KEY?: string;
  CW_MANAGE_CLIENT_ID?: string;
  CW_MANAGE_URL?: string;
  AUTH_MODE?: string;
  LOG_LEVEL?: string;
  /** Required in env mode when CW_MANAGE_* secrets are set. */
  MCP_BEARER_TOKEN?: string;
}

/** Constant-time string compare (no early exit on the first differing byte). */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

function hasEnvCredentials(env: Env): boolean {
  return Boolean(
    env.CW_MANAGE_COMPANY_ID ||
      env.CW_MANAGE_PUBLIC_KEY ||
      env.CW_MANAGE_PRIVATE_KEY ||
      env.CW_MANAGE_CLIENT_ID,
  );
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, X-CW-Company-Id, X-CW-Public-Key, X-CW-Private-Key, X-CW-Client-Id, X-CW-Url",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Shallow, unauthenticated liveness probe.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      return json({ status: "ok" });
    }

    if (url.pathname === "/mcp") {
      const isGatewayMode = (env.AUTH_MODE ?? "env") === "gateway";

      let configOverride: CwManageConfig | undefined;
      if (isGatewayMode) {
        const { config, error } = resolveGatewayConfig(
          (name) => request.headers.get(name) ?? undefined,
        );
        if (error) {
          return json(
            {
              error: "Missing credentials",
              message: error,
              required: [
                "X-CW-Company-Id",
                "X-CW-Public-Key",
                "X-CW-Private-Key",
                "X-CW-Client-Id",
              ],
              optional: ["X-CW-Url"],
            },
            401,
          );
        }
        configOverride = config;
      } else {
        if (hasEnvCredentials(env)) {
          const expected = env.MCP_BEARER_TOKEN?.trim();
          if (!expected) {
            return json(
              {
                error: "Not configured",
                message:
                  "This Worker has ConnectWise credentials but no MCP_BEARER_TOKEN, so /mcp is disabled. Set the MCP_BEARER_TOKEN secret.",
              },
              503,
            );
          }
          const header = request.headers.get("Authorization") ?? "";
          const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
          if (!presented || !timingSafeEqual(presented, expected)) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                "WWW-Authenticate": 'Bearer realm="connectwise-manage-mcp"',
                ...CORS_HEADERS,
              },
            });
          }
        }
        // env mode: build config from Worker secrets if present.
        // (Absent creds are fine — tools/list still works, tools/call errors.)
        const { config } = buildConfig(
          env.CW_MANAGE_COMPANY_ID,
          env.CW_MANAGE_PUBLIC_KEY,
          env.CW_MANAGE_PRIVATE_KEY,
          env.CW_MANAGE_CLIENT_ID,
          env.CW_MANAGE_URL,
        );
        configOverride = config;
      }

      // Fresh server + transport per request (stateless).
      const server = createMcpServer(configOverride);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);

      try {
        const response = await transport.handleRequest(request);
        return withCors(response);
      } finally {
        await transport.close();
        await server.close();
      }
    }

    return json({ error: "Not found", endpoints: ["/mcp", "/health"] }, 404);
  },
};
