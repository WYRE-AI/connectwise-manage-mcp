/**
 * Tests for request target parsing (issue #102).
 *
 * A malformed Host header such as "[" used to throw ERR_INVALID_URL inside the
 * HTTP request listener and end the process. The request target is now parsed
 * against a fixed base, so Host cannot affect it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { isValidHostHeader, parseRequestTarget } from "../request-target.js";
import { handleAuthorize } from "../auth/routes.js";
import type { EntraConfig } from "../auth/types.js";

describe("parseRequestTarget", () => {
  it("parses an origin-form target with its path and query", () => {
    const url = parseRequestTarget("/authorize?state=abc&nonce=1");
    expect(url?.pathname).toBe("/authorize");
    expect(url?.searchParams.get("state")).toBe("abc");
  });

  it("treats a missing target as the root path", () => {
    expect(parseRequestTarget(undefined)?.pathname).toBe("/");
    expect(parseRequestTarget("")?.pathname).toBe("/");
  });

  it.each([
    ["a network-path reference", "//evil.example/mcp"],
    ["an absolute-form target", "http://evil.example/mcp"],
    ["an asterisk-form target", "*"],
    ["an authority-form target", "evil.example:443"],
    ["a relative path", "mcp"],
  ])("rejects %s", (_label, target) => {
    expect(parseRequestTarget(target)).toBeNull();
  });

  it("never takes its host from the target", () => {
    expect(parseRequestTarget("/mcp")?.host).toBe("localhost");
  });
});

describe("isValidHostHeader", () => {
  it.each([
    ["a name", "mcp.example.com"],
    ["a name with a port", "localhost:8080"],
    ["an IPv4 address with a port", "127.0.0.1:8080"],
    ["an IPv6 literal with a port", "[::1]:8080"],
    ["a missing header", undefined],
  ])("accepts %s", (_label, host) => {
    expect(isValidHostHeader(host)).toBe(true);
  });

  it.each([
    ["an unclosed bracket", "["],
    ["a space", "a b"],
    ["a path", "example.com/path"],
    ["userinfo", "user@example.com"],
    ["a query", "example.com?x=1"],
    ["a port that is not a number", "example.com:port"],
  ])("rejects %s", (_label, host) => {
    expect(isValidHostHeader(host)).toBe(false);
  });
});

describe("handleAuthorize", () => {
  const config = { tenantId: "tenant-guid", clientId: "client-guid" } as EntraConfig;

  function fakeResponse() {
    const captured: { status?: number; headers?: Record<string, unknown>; body?: string } = {};
    const res = {
      writeHead(status: number, headers?: Record<string, unknown>) {
        captured.status = status;
        captured.headers = headers;
        return res;
      },
      end(body?: string) {
        captured.body = body;
      },
    } as unknown as ServerResponse;
    return { res, captured };
  }

  function fakeRequest(url: string, host: string) {
    return { url, headers: { host } } as unknown as IncomingMessage;
  }

  it("redirects to Azure AD with the PKCE parameters when Host is malformed", () => {
    const { res, captured } = fakeResponse();

    handleAuthorize(fakeRequest("/authorize?state=abc&code_challenge=xyz", "["), res, config);

    expect(captured.status).toBe(302);
    const location = new URL(String(captured.headers?.Location));
    expect(location.hostname).toBe("login.microsoftonline.com");
    expect(location.searchParams.get("state")).toBe("abc");
    expect(location.searchParams.get("code_challenge")).toBe("xyz");
    expect(location.searchParams.get("client_id")).toBe("client-guid");
  });

  it("answers 400 and does not redirect when the request target is not a path", () => {
    const { res, captured } = fakeResponse();

    handleAuthorize(fakeRequest("//evil.example/authorize", "localhost"), res, config);

    expect(captured.status).toBe(400);
    expect(JSON.parse(String(captured.body))).toEqual({ error: "invalid_request" });
  });
});

describe("HTTP server with a malformed Host header", () => {
  let port = 0;

  /** Send one raw HTTP/1.1 request and resolve with the status code. */
  function rawRequest(requestLine: string, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      let received = "";
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error("no response within 5 seconds"));
      });
      socket.on("connect", () => {
        socket.write(`${requestLine} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
      socket.on("data", (chunk) => {
        received += chunk.toString("latin1");
      });
      socket.on("error", reject);
      socket.on("close", () => {
        const match = /^HTTP\/1\.1 (\d{3})/.exec(received);
        if (match) resolve(Number(match[1]));
        else reject(new Error("connection closed with no HTTP response"));
      });
    });
  }

  beforeAll(async () => {
    // Find a free port, then start the real server on it by importing the
    // entry point, which starts its transport on import.
    port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const found = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(found));
      });
    });
    process.env.MCP_TRANSPORT = "http";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.MCP_HTTP_PORT = String(port);
    await import("../index.js");
    // main() is not awaited by the module, so wait until the port answers.
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await rawRequest("GET /health", "localhost");
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error("server did not start");
  });

  afterAll(() => {
    delete process.env.MCP_TRANSPORT;
    delete process.env.MCP_HTTP_HOST;
    delete process.env.MCP_HTTP_PORT;
  });

  it("answers 400 to a malformed Host header", async () => {
    expect(await rawRequest("GET /health", "[")).toBe(400);
  });

  it("answers 400 to a request target that is not a path", async () => {
    expect(await rawRequest("GET //evil.example/health", "localhost")).toBe(400);
  });

  it("stays up and serves the next request after malformed ones", async () => {
    expect(await rawRequest("GET /health", "[")).toBe(400);
    expect(await rawRequest("GET /mcp", "a b")).toBe(400);
    expect(await rawRequest("GET //evil.example/health", "[")).toBe(400);
    expect(await rawRequest("GET /health", "localhost")).toBe(200);
  });
});
