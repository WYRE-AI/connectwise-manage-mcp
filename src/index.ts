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
 *   MCP_HTTP_HOST               - HTTP host (default: 0.0.0.0)
 *   AUTH_MODE                   - "env" (default) or "gateway" for header-based auth
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

// Conduit service-to-service auth (gateway#377 parity). Non-empty =
// enforce X-Gateway-S2S on every /mcp request; empty = disabled, behavior
// exactly as before (dark-by-default until the gateway provisions this
// container's derived subkey). See src/s2s-verify.ts.
const S2S_SECRET = process.env.CONDUIT_S2S_SECRET || "";

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

async function startHttpTransport(): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = process.env.MCP_HTTP_HOST || "0.0.0.0";
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
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );

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
      if (S2S_SECRET && !verifyS2sHeader(req.headers[S2S_HEADER] as string | undefined, S2S_SECRET)) {
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
          const { config, error } = resolveGatewayConfig(
            (name) => req.headers[name] as string | undefined,
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

main().catch(console.error);
