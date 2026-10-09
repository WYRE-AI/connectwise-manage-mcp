import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import { CwManageClient, type CwManageConfig } from "../api-client.js";
import { resolveGatewayConfig } from "../mcp-server.js";
import { assertSafeGatewayUrl, isPublicIp } from "../url-guard.js";

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function gatewayConfig(url: string | undefined): CwManageConfig {
  const headers: Record<string, string | undefined> = {
    "x-cw-company-id": "acme",
    "x-cw-public-key": "pub",
    "x-cw-private-key": "priv",
    "x-cw-client-id": "client-1",
    "x-cw-url": url,
  };
  return resolveGatewayConfig((name) => headers[name]).config!;
}

describe("isPublicIp", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1",
  ])("rejects %s", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each(["8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "accepts %s",
    (ip) => {
      expect(isPublicIp(ip)).toBe(true);
    },
  );
});

describe("assertSafeGatewayUrl", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
  });

  it("accepts an https URL that resolves to a public address", async () => {
    await expect(assertSafeGatewayUrl("https://cw.example.com")).resolves.toBeUndefined();
  });

  it.each([
    ["http", "http://cw.example.com"],
    ["credentials", "https://u:p@cw.example.com"],
    ["query", "https://cw.example.com/?probe=1"],
    ["fragment", "https://cw.example.com/chosen#"],
    ["garbage", "not a url"],
  ])("rejects a URL with %s before any DNS lookup", async (_, url) => {
    await expect(assertSafeGatewayUrl(url)).rejects.toThrow();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects a hostname with any non-public address", async () => {
    lookupMock.mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(assertSafeGatewayUrl("https://cw.example.com")).rejects.toThrow(/non-public/);
  });

  it("rejects a hostname that does not resolve", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertSafeGatewayUrl("https://nope.example.com")).rejects.toThrow(/did not resolve/);
  });
});

describe("CwManageClient with a gateway-supplied URL", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks fetch not to follow redirects and sets a timeout on every request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await new CwManageClient(gatewayConfig("https://cw.example.com")).get("/system/info");

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.redirect).toBe("manual");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws on a redirect response without following it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({}, 302));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new CwManageClient(gatewayConfig("https://cw.example.com")).get("/system/info"),
    ).rejects.toThrow(/redirect \(HTTP 302\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-checks the hostname on every request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CwManageClient(gatewayConfig("https://cw.example.com"));

    await client.get("/system/info");
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);

    await expect(client.get("/system/info")).rejects.toThrow(/non-public/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never fetches the reporter's loopback URL", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = new CwManageClient(gatewayConfig("http://127.0.0.1:8080/chosen?probe=1#"));

    await expect(client.get("/system/info")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not look up the default cloud URL when no header is sent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await new CwManageClient(gatewayConfig(undefined)).get("/system/info");

    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/api-na\.myconnectwise\.net\//);
  });

  it("does not check an env-mode URL, so LAN self-hosters keep working", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await new CwManageClient({
      baseUrl: "https://10.0.0.5",
      companyId: "acme",
      publicKey: "pub",
      privateKey: "priv",
      clientId: "client-1",
    }).get("/system/info");

    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
