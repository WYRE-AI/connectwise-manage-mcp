#!/usr/bin/env node
/**
 * ConnectWise Manage MCP Server
 *
 * Provides MCP tools for interacting with the ConnectWise Manage (PSA) REST API.
 * Supports both cloud-hosted and self-hosted ConnectWise Manage instances.
 *
 * Required environment variables:
 *   CW_MANAGE_COMPANY_ID        - Your ConnectWise company identifier
 *   CW_MANAGE_PUBLIC_KEY        - API member public key
 *   CW_MANAGE_PRIVATE_KEY       - API member private key
 *   CW_MANAGE_CLIENT_ID         - Client ID from ConnectWise Developer Portal
 *
 * Optional environment variables:
 *   CW_MANAGE_URL               - API base URL (default: https://api-na.myconnectwise.net)
 *                                  Cloud: api-na.myconnectwise.net, api-eu.myconnectwise.net, api-au.myconnectwise.net
 *                                  Self-hosted: https://cwm.yourcompany.com (or with full path)
 *   CW_MANAGE_REJECT_UNAUTHORIZED - Set to "false" for self-signed certs (default: "true")
 *   MCP_TRANSPORT               - "stdio" (default) or "http"
 *   MCP_HTTP_PORT               - HTTP port (default: 8080)
 *   MCP_HTTP_HOST               - HTTP bind address. Defaults to 127.0.0.1.
 *                                 Honored only when CONDUIT_S2S_SECRET is set.
 *                                 Without a secret, MCP_ALLOW_INSECURE_DEV=1
 *                                 forces 127.0.0.1.
 *   AUTH_MODE                   - "env" (default) or "gateway" for header-based auth
 *   CONDUIT_S2S_SECRET          - Required to start HTTP. Empty and known
 *                                 placeholders refuse to start.
 *   MCP_ALLOW_INSECURE_DEV      - Set to "1" to start HTTP without a secret.
 *                                 Listens on 127.0.0.1 only. Local development.
 *
 * Entra ID OAuth 2.1 (optional — set MCP_OAUTH_ENABLED=true to activate):
 *   MCP_OAUTH_ENABLED           - Enable Entra ID auth middleware (default: false)
 *   MCP_SERVER_URL              - Full public URL of this server (e.g. https://mcp.yourdomain.com)
 *   AZURE_TENANT_ID             - Entra tenant GUID
 *   AZURE_CLIENT_ID             - App registration client ID
 *   AZURE_AUDIENCE              - Token audience, typically api://<AZURE_CLIENT_ID>
 *   AZURE_REQUIRED_ROLE         - App role claim required on every request (default: CWM.Access)
 *   MCP_BEARER_TOKEN            - Static bearer token for Claude Code CLI / Claude Desktop
 */

import {
  createServer,
  IncomingMessage,
  ServerResponse,
  Server as HttpServer,
} from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getEntraConfig, createJwksClient, validateToken } from "./auth/middleware.js";
import {
  handleProtectedResource,
  handleAuthServerMetadata,
  handleRegister,
  handleAuthorize,
  handleToken,
} from "./auth/routes.js";
import { AuthError } from "./auth/types.js";
import {
  createMcpServer,
  resolveGatewayConfig,
  type CwManageConfig,
} from "./mcp-server.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";
import { isValidHostHeader, parseRequestTarget } from "./request-target.js";

/**
 * Public example values. A copied placeholder must not verify as a real
 * secret, and MCP_ALLOW_INSECURE_DEV does not bypass this list.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const LOOPBACK_HOST = "127.0.0.1";

const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
  "An empty secret would accept unauthenticated /mcp requests (CWE-306). " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned service-to-service secret, " +
  "or set MCP_ALLOW_INSECURE_DEV=1 to bypass this check for local development only.";

const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is starting WITHOUT service-to-service authentication and listens on 127.0.0.1 only. " +
  "Do not use MCP_ALLOW_INSECURE_DEV outside local development.";

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Hosts that are already loopback. The insecure-dev bypass still binds 127.0.0.1. */
function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1") {
    return true;
  }
  const bare = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === "127";
}

/**
 * Secret for X-Gateway-S2S on /mcp. Read at HTTP startup, not module load.
 * Empty fails closed unless MCP_ALLOW_INSECURE_DEV=1. A known placeholder
 * always fails closed. The secret value is never written to logs.
 */
function resolveHttpS2sSecret(): string {
  const secret = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  if (KNOWN_PLACEHOLDER_SECRETS.has(secret.toLowerCase())) {
    console.error(PLACEHOLDER_S2S_SECRET_ERROR);
    process.exit(1);
  }
  if (secret) return secret;

  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") {
    console.error(INSECURE_DEV_WARNING);
    return "";
  }

  console.error(MISSING_S2S_SECRET_ERROR);
  process.exit(1);
}

/**
 * No secret (insecure-dev bypass only): always 127.0.0.1, including when
 * MCP_HTTP_HOST is a wider address such as 0.0.0.0.
 * A configured secret honors MCP_HTTP_HOST. Unset defaults to 127.0.0.1.
 */
function resolveListenHost(s2sSecret: string): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (s2sSecret) return configured || LOOPBACK_HOST;
  if (configured && !isLoopbackHost(configured)) {
    console.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        "MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. " +
        `Binding ${LOOPBACK_HOST} only.`,
    );
  }
  return LOOPBACK_HOST;
}

// ---------------------------------------------------------------------------
// Transport: stdio
// ---------------------------------------------------------------------------

async function startStdioTransport(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ConnectWise Manage MCP server running on stdio");
}

// ---------------------------------------------------------------------------
// Transport: HTTP (StreamableHTTPServerTransport)
// ---------------------------------------------------------------------------

let httpServer: HttpServer | undefined;

export async function startHttpTransport(): Promise<HttpServer> {
  const s2sSecret = resolveHttpS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  // Loopback unless the operator opts into a wider bind. A wider bind is
  // honored only when CONDUIT_S2S_SECRET is set. The insecure-dev bypass
  // always listens on 127.0.0.1, including when the image sets 0.0.0.0.
  const host = resolveListenHost(s2sSecret);
  const authMode = process.env.AUTH_MODE || "env";
  const isGatewayMode = authMode === "gateway";

  // ---------------------------------------------------------------------------
  // Entra ID auth setup (optional)
  // ---------------------------------------------------------------------------
  const oauthEnabled = process.env.MCP_OAUTH_ENABLED === "true";
  let entraConfig: ReturnType<typeof getEntraConfig> | null = null;
  let jwksClient: ReturnType<typeof createJwksClient> | null = null;

  if (oauthEnabled) {
    entraConfig = getEntraConfig();
    jwksClient = createJwksClient(entraConfig);
    console.error(
      `[auth] Entra ID OAuth enabled — tenant: ${entraConfig.tenantId}, required role: ${entraConfig.requiredRole}`,
    );
    if (entraConfig.bearerToken) {
      console.error("[auth] Static bearer token fallback enabled (CLI/Desktop)");
    }
  }

  httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The request target is parsed against a fixed base, never against the
    // client-supplied Host header. A malformed Host or target is answered
    // with 400: it must not be able to throw here and end the process.
    const url = isValidHostHeader(req.headers.host)
      ? parseRequestTarget(req.url)
      : null;
    if (!url) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_request" }));
      return;
    }

    // ------------------------------------------------------------------
    // OAuth discovery + proxy endpoints (always available when OAuth on)
    // ------------------------------------------------------------------
    if (oauthEnabled && entraConfig) {
      if (
        url.pathname === "/.well-known/oauth-protected-resource" &&
        req.method === "GET"
      ) {
        handleProtectedResource(res, entraConfig);
        return;
      }

      if (
        url.pathname === "/.well-known/oauth-authorization-server" &&
        req.method === "GET"
      ) {
        handleAuthServerMetadata(res, entraConfig);
        return;
      }

      if (url.pathname === "/register" && req.method === "POST") {
        handleRegister(req, res, entraConfig).catch((err) => {
          console.error("[auth] /register error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "internal_error" }));
          }
        });
        return;
      }

      if (url.pathname === "/authorize" && req.method === "GET") {
        handleAuthorize(req, res, entraConfig);
        return;
      }

      if (url.pathname === "/token" && req.method === "POST") {
        handleToken(req, res, entraConfig).catch((err) => {
          console.error("[auth] /token error:", err);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "token_proxy_error" }));
          }
        });
        return;
      }
    }

    // Health endpoint
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          transport: "http",
          authMode: isGatewayMode ? "gateway" : "env",
          oauthEnabled,
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    // MCP endpoint - stateless: fresh server + transport per request
    if (url.pathname === "/mcp") {
      // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1;
      // startup refuses otherwise. A configured secret is always enforced,
      // before any credential extraction.
      if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
          })
        );
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed" },
            id: null,
          }),
        );
        return;
      }

      // ------------------------------------------------------------------
      // Entra ID auth check
      // ------------------------------------------------------------------
      const handleMcp = async () => {
        if (oauthEnabled && entraConfig) {
          const authHeader = req.headers.authorization;

          if (!authHeader?.startsWith("Bearer ")) {
            res.writeHead(401, {
              "Content-Type": "application/json",
              "WWW-Authenticate": `Bearer resource_metadata="${entraConfig.serverUrl}/.well-known/oauth-protected-resource"`,
            });
            res.end(
              JSON.stringify({
                error: "unauthorized",
                message: "Bearer token required",
              }),
            );
            return;
          }

          const token = authHeader.slice(7);

          try {
            let identity;
            // Static bearer token check (Claude Code CLI / Claude Desktop)
            // Use timing-safe comparison to prevent token length oracle attacks
            const staticTokenMatch =
              entraConfig.bearerToken !== undefined &&
              timingSafeEqual(
                createHash("sha256").update(token).digest(),
                createHash("sha256").update(entraConfig.bearerToken).digest(),
              );
            if (staticTokenMatch) {
              identity = {
                upn: "cli-user",
                roles: [entraConfig.requiredRole],
                oid: "static",
              };
            } else {
              identity = await validateToken(token, entraConfig, jwksClient!);
            }
            console.error(
              `[audit] ${identity.upn} | ${new Date().toISOString()} | POST /mcp`,
            );
          } catch (err) {
            if (err instanceof AuthError) {
              res.writeHead(err.statusCode, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "auth_failed", message: err.message }));
            } else {
              console.error("[auth] Unexpected validation error:", err);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "internal_error" }));
            }
            return;
          }
        }

        // ------------------------------------------------------------------
        // Gateway mode: extract CW credentials from headers (per request,
        // no global process.env mutation so concurrent requests stay isolated)
        // ------------------------------------------------------------------
        let configOverride: CwManageConfig | undefined;
        if (isGatewayMode) {
          // Gateway mode: credentials must arrive on every request via the
          // X-CW-* headers. Reject explicitly when any required header is
          // missing. Falling through would resolve CW_MANAGE_* from the
          // process environment, which is not request-scoped.
          const { config, error } = resolveGatewayConfig((name) =>
            headerValue(req.headers[name]),
          );
          if (error) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "Missing credentials",
                message:
                  "Gateway mode requires X-CW-Company-Id, X-CW-Public-Key, X-CW-Private-Key, and X-CW-Client-Id headers",
                required: [
                  "X-CW-Company-Id",
                  "X-CW-Public-Key",
                  "X-CW-Private-Key",
                  "X-CW-Client-Id",
                ],
              }),
            );
            return;
          }
          configOverride = config;
        }

        // ------------------------------------------------------------------
        // MCP handler
        // ------------------------------------------------------------------
        const server = createMcpServer(configOverride);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        res.on("close", () => {
          transport.close();
          server.close();
        });

        await server.connect(transport as unknown as Transport);
        transport.handleRequest(req, res);
      };

      handleMcp().catch((err) => {
        console.error("MCP transport error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal error" },
              id: null,
            }),
          );
        }
      });

      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }),
    );
  });

  await new Promise<void>((resolve) => {
    httpServer!.listen(port, host, () => {
      console.error(
        `ConnectWise Manage MCP server listening on http://${host}:${port}/mcp`,
      );
      console.error(`Health check available at http://${host}:${port}/health`);
      console.error(
        `Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`,
      );
      resolve();
    });
  });

  return httpServer!;
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupShutdownHandlers(): void {
  const shutdown = async () => {
    console.error("Shutting down ConnectWise Manage MCP server...");
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  setupShutdownHandlers();

  const transportType = process.env.MCP_TRANSPORT || "stdio";

  if (transportType === "http") {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }
}

// Vitest imports this module to call startHttpTransport. Skip the CLI
// entrypoint there. `node dist/index.js` still starts stdio or HTTP.
if (process.env.VITEST !== "true") {
  main().catch(console.error);
}
