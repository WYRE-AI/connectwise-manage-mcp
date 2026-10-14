/**
 * HTTP transport fail-closed auth (CWE-306).
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * Known placeholder secrets always refuse to start. The dev bypass binds
 * 127.0.0.1 only. /mcp rejects a missing or invalid X-Gateway-S2S header.
 * AUTH_MODE=gateway rejects requests that omit vendor credential headers
 * and must not fall back to CW_MANAGE_* in process.env.
 */

import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CwManageConfig } from "../api-client.js";

const constructed = vi.hoisted(() => [] as CwManageConfig[]);
const getConfigCalls = vi.hoisted(() => ({ n: 0 }));

vi.mock("../api-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api-client.js")>();
  return {
    ...actual,
    getConfig: () => {
      getConfigCalls.n += 1;
      return actual.getConfig();
    },
    CwManageClient: class extends actual.CwManageClient {
      constructor(config: CwManageConfig) {
        super(config);
        constructed.push({ ...config });
      }
    },
  };
});

import { startHttpTransport } from "../index.js";

const S2S_SECRET = "s2s-do-not-log-7f3a9c";
const ENV_COMPANY = "env-company-must-not-be-used";
const ENV_PUBLIC = "env-public-must-not-be-used";
const ENV_PRIVATE = "env-private-must-not-be-used";
const ENV_CLIENT = "env-client-must-not-be-used";

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "AUTH_MODE",
  "MCP_TRANSPORT",
  "MCP_OAUTH_ENABLED",
  "CW_MANAGE_COMPANY_ID",
  "CW_MANAGE_PUBLIC_KEY",
  "CW_MANAGE_PRIVATE_KEY",
  "CW_MANAGE_CLIENT_ID",
  "CW_MANAGE_URL",
  "CW_MANAGE_REJECT_UNAUTHORIZED",
] as const;

const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

const servers: HttpServer[] = [];

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function resetCredentialSpies(): void {
  constructed.length = 0;
  getConfigCalls.n = 0;
}

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  });
  return {
    text: () => lines.join("\n"),
    restore: () => spy.mockRestore(),
  };
}

function installExitSpy() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code ?? ""}`);
  }) as typeof process.exit);
}

function assertNoSecrets(text: string): void {
  expect(text).not.toContain(S2S_SECRET);
  expect(text).not.toContain(ENV_COMPANY);
  expect(text).not.toContain(ENV_PUBLIC);
  expect(text).not.toContain(ENV_PRIVATE);
  expect(text).not.toContain(ENV_CLIENT);
}

function useCredentialEnv(): void {
  process.env.CW_MANAGE_COMPANY_ID = ENV_COMPANY;
  process.env.CW_MANAGE_PUBLIC_KEY = ENV_PUBLIC;
  process.env.CW_MANAGE_PRIVATE_KEY = ENV_PRIVATE;
  process.env.CW_MANAGE_CLIENT_ID = ENV_CLIENT;
  process.env.CW_MANAGE_URL = "https://env.example.invalid";
  process.env.CW_MANAGE_REJECT_UNAUTHORIZED = "true";
  delete process.env.MCP_OAUTH_ENABLED;
}

interface HttpResult {
  status: number;
  body: string;
}

function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.setTimeout(5000, () => {
      req.destroy(new Error(`timeout ${options.method} ${options.path}`));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function mcpHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

const toolsListBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {},
});

async function listen(): Promise<{ server: HttpServer; port: number; address: string }> {
  process.env.MCP_HTTP_PORT = "0";
  const server = await startHttpTransport();
  servers.push(server);
  const info = server.address();
  if (!info || typeof info === "string") {
    throw new Error("expected a TCP listen address");
  }
  return { server, port: info.port, address: info.address };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
  restoreEnv();
  resetCredentialSpies();
});

describe("HTTP startup fails closed without CONDUIT_S2S_SECRET", () => {
  it("logs an error and exits when the secret is unset", async () => {
    delete process.env.CONDUIT_S2S_SECRET;
    delete process.env.MCP_ALLOW_INSECURE_DEV;
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.MCP_HTTP_PORT = "0";
    useCredentialEnv();

    const logs = captureStderr();
    const exitSpy = installExitSpy();
    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = logs.text();
    expect(logged).toContain("Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty.");
    expect(logged).toContain("CWE-306");
    expect(logged).toContain("MCP_ALLOW_INSECURE_DEV=1");
    assertNoSecrets(logged);
  });

  it("exits when the secret is whitespace and the dev flag is not exactly 1", async () => {
    process.env.CONDUIT_S2S_SECRET = "   ";
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.MCP_HTTP_PORT = "0";

    const logs = captureStderr();
    installExitSpy();
    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    expect(logs.text()).toContain("CONDUIT_S2S_SECRET is empty");
  });

  it.each([
    "replace-with-a-real-secret",
    "changeme",
    "secret",
    "your-s2s-secret",
    "  Your-Secret  ",
  ])("refuses known placeholder %j and does not log it", async (placeholder) => {
    process.env.CONDUIT_S2S_SECRET = placeholder;
    delete process.env.MCP_ALLOW_INSECURE_DEV;
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.MCP_HTTP_PORT = "0";

    const logs = captureStderr();
    const exitSpy = installExitSpy();
    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = logs.text();
    expect(logged).toBe(
      "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
        "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.",
    );
  });

  it("refuses a placeholder even when MCP_ALLOW_INSECURE_DEV=1", async () => {
    process.env.CONDUIT_S2S_SECRET = "  Change-Me  ";
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.MCP_HTTP_PORT = "0";

    const logs = captureStderr();
    installExitSpy();
    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    expect(logs.text()).toBe(
      "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
        "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.",
    );
  });

  it("starts with a warning and binds 127.0.0.1 when MCP_ALLOW_INSECURE_DEV=1", async () => {
    delete process.env.CONDUIT_S2S_SECRET;
    delete process.env.MCP_HTTP_HOST;
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.AUTH_MODE = "gateway";
    useCredentialEnv();

    const logs = captureStderr();
    const exitSpy = installExitSpy();
    const server = await listen();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(server.address).toBe("127.0.0.1");
    const logged = logs.text();
    expect(logged).toContain("SECURITY WARNING");
    expect(logged).toContain("MCP_ALLOW_INSECURE_DEV=1");
    expect(logged).toContain("WITHOUT service-to-service authentication");
    expect(logged).toContain("127.0.0.1");
    expect(logged).not.toContain("not a loopback address");
    assertNoSecrets(logged);
  });

  it("forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is not loopback", async () => {
    delete process.env.CONDUIT_S2S_SECRET;
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    process.env.AUTH_MODE = "gateway";

    const logs = captureStderr();
    const exitSpy = installExitSpy();
    const server = await listen();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(server.address).toBe("127.0.0.1");
    const logged = logs.text();
    expect(logged).toContain("MCP_HTTP_HOST=0.0.0.0 is not a loopback address");
    expect(logged).toContain("Binding 127.0.0.1 only");
    assertNoSecrets(logged);
  });

  it("honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    delete process.env.MCP_ALLOW_INSECURE_DEV;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    process.env.AUTH_MODE = "gateway";

    const logs = captureStderr();
    const server = await listen();

    expect(server.address).toBe("0.0.0.0");
    expect(logs.text()).not.toContain("not a loopback address");
    assertNoSecrets(logs.text());
  });

  it("defaults to 127.0.0.1 when a secret is set and MCP_HTTP_HOST is unset", async () => {
    process.env.CONDUIT_S2S_SECRET = `  ${S2S_SECRET}  `;
    delete process.env.MCP_ALLOW_INSECURE_DEV;
    delete process.env.MCP_HTTP_HOST;
    process.env.AUTH_MODE = "gateway";

    const logs = captureStderr();
    const server = await listen();

    expect(server.address).toBe("127.0.0.1");
    assertNoSecrets(logs.text());
  });
});

describe("gateway /mcp auth", () => {
  async function startGateway(): Promise<number> {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    delete process.env.MCP_ALLOW_INSECURE_DEV;
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.AUTH_MODE = "gateway";
    useCredentialEnv();
    const server = await listen();
    return server.port;
  }

  it("returns 401 when the S2S header is missing or invalid and does not read credentials", async () => {
    const logs = captureStderr();
    const port = await startGateway();
    resetCredentialSpies();

    const credentialHeaders = {
      "x-cw-company-id": "header-company",
      "x-cw-public-key": "header-public",
      "x-cw-private-key": "header-private",
      "x-cw-client-id": "header-client",
    };

    const missing = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders(credentialHeaders),
      body: toolsListBody,
    });
    expect(missing.status).toBe(401);
    expect(missing.body).toContain("X-Gateway-S2S");
    assertNoSecrets(missing.body);

    const invalid = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        ...credentialHeaders,
        "x-gateway-s2s": mintS2sHeader("wrong-secret"),
      }),
      body: toolsListBody,
    });
    expect(invalid.status).toBe(401);
    expect(invalid.body).toContain("X-Gateway-S2S");
    expect(getConfigCalls.n).toBe(0);
    expect(constructed).toEqual([]);
    assertNoSecrets(logs.text());
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const port = await startGateway();
    resetCredentialSpies();

    const response = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
      body: toolsListBody,
    });
    expect(response.status).toBe(401);
    const body = JSON.parse(response.body) as { error?: string; message?: string };
    expect(body.error).toBe("Missing credentials");
    expect(body.message).toContain("X-CW-Company-Id");
    assertNoSecrets(response.body);
    expect(getConfigCalls.n).toBe(0);
    expect(constructed).toEqual([]);

    resetCredentialSpies();
    const partial = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-cw-company-id": "header-company",
        "x-cw-public-key": "header-public",
        "x-cw-private-key": "header-private",
      }),
      body: toolsListBody,
    });
    expect(partial.status).toBe(401);
    expect(getConfigCalls.n).toBe(0);
    expect(constructed).toEqual([]);
    assertNoSecrets(partial.body);
  });

  it("accepts a valid S2S header plus credential headers and uses those credentials", async () => {
    const logs = captureStderr();
    const port = await startGateway();
    resetCredentialSpies();

    const response = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-cw-company-id": "header-company",
        "x-cw-public-key": "header-public",
        "x-cw-private-key": "header-private",
        "x-cw-client-id": "header-client",
        "x-cw-url": "https://header.example",
      }),
      body: toolsListBody,
    });

    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as {
      result?: { tools?: Array<{ name?: string }> };
    };
    const names = (payload.result?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("cw_search_tickets");
    expect(getConfigCalls.n).toBe(0);
    expect(constructed).toEqual([
      {
        baseUrl: "https://header.example",
        companyId: "header-company",
        publicKey: "header-public",
        privateKey: "header-private",
        clientId: "header-client",
      },
    ]);
    assertNoSecrets(response.body);
    assertNoSecrets(logs.text());
  });

  it("serves /health without authentication and without reading credentials", async () => {
    const port = await startGateway();
    resetCredentialSpies();

    const response = await sendHttp({
      port,
      method: "GET",
      path: "/health",
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { status?: string; authMode?: string };
    expect(body.status).toBe("ok");
    expect(body.authMode).toBe("gateway");
    assertNoSecrets(response.body);
    expect(getConfigCalls.n).toBe(0);
    expect(constructed).toEqual([]);
  });
});

describe("env-mode HTTP still requires S2S", () => {
  it("uses CW_MANAGE_* after a valid S2S header and ignores a partial header set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    delete process.env.MCP_ALLOW_INSECURE_DEV;
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.AUTH_MODE = "env";
    useCredentialEnv();

    const port = (await listen()).port;
    resetCredentialSpies();

    const response = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-cw-company-id": "header-company-must-not-be-used",
      }),
      body: toolsListBody,
    });

    expect(response.status).toBe(200);
    expect(getConfigCalls.n).toBe(1);
    expect(constructed).toEqual([
      {
        baseUrl: "https://env.example.invalid",
        companyId: ENV_COMPANY,
        publicKey: ENV_PUBLIC,
        privateKey: ENV_PRIVATE,
        clientId: ENV_CLIENT,
      },
    ]);
    expect(response.body).not.toContain("header-company-must-not-be-used");
    expect(response.body).not.toContain(S2S_SECRET);
  });
});
