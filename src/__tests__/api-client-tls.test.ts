import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Agent } from "undici";
import { CwManageClient, type CwManageConfig } from "../api-client.js";

const baseConfig: CwManageConfig = {
  baseUrl: "https://api-na.myconnectwise.net",
  companyId: "acme",
  publicKey: "pub",
  privateKey: "priv",
  clientId: "client-1",
};

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("CwManageClient TLS dispatcher (no process.env mutation)", () => {
  const savedRejectEnv = process.env.CW_MANAGE_REJECT_UNAUTHORIZED;
  const savedTlsEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  beforeEach(() => {
    delete process.env.CW_MANAGE_REJECT_UNAUTHORIZED;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  });

  afterEach(() => {
    if (savedRejectEnv === undefined) delete process.env.CW_MANAGE_REJECT_UNAUTHORIZED;
    else process.env.CW_MANAGE_REJECT_UNAUTHORIZED = savedRejectEnv;
    if (savedTlsEnv === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTlsEnv;
    vi.unstubAllGlobals();
  });

  it("never reads or writes process.env.NODE_TLS_REJECT_UNAUTHORIZED", async () => {
    process.env.CW_MANAGE_REJECT_UNAUTHORIZED = "false";
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CwManageClient(baseConfig);
    await client.get("/system/info");

    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it("passes a per-instance undici Agent as the fetch dispatcher, not a global toggle", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CwManageClient(baseConfig);
    await client.get("/system/info");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, { dispatcher?: unknown }];
    expect(options.dispatcher).toBeInstanceOf(Agent);
  });

  it("two client instances with different rejectUnauthorized settings get distinct dispatchers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    process.env.CW_MANAGE_REJECT_UNAUTHORIZED = "false";
    const selfHostedClient = new CwManageClient({ ...baseConfig, clientId: "self-hosted" });

    delete process.env.CW_MANAGE_REJECT_UNAUTHORIZED;
    const cloudClient = new CwManageClient({ ...baseConfig, clientId: "cloud" });

    await Promise.all([
      selfHostedClient.get("/system/info"),
      cloudClient.get("/system/info"),
    ]);

    const dispatchers = fetchMock.mock.calls.map(
      (c) => (c[1] as { dispatcher?: unknown }).dispatcher,
    );
    expect(dispatchers).toHaveLength(2);
    // Each request carries its own client's dispatcher instance -- one relaxed,
    // one strict -- never a shared/global toggle that could bleed between them.
    expect(dispatchers[0]).not.toBe(dispatchers[1]);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });
});
