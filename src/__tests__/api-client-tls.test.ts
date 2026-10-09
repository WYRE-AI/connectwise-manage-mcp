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

  it("uses Node's default fetch dispatcher when TLS verification is not relaxed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CwManageClient(baseConfig);
    await client.get("/system/info");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, { dispatcher?: unknown }];
    expect(options).not.toHaveProperty("dispatcher");
  });

  it("passes a per-instance undici Agent as the fetch dispatcher when relaxed, not a global toggle", async () => {
    process.env.CW_MANAGE_REJECT_UNAUTHORIZED = "false";
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CwManageClient(baseConfig);
    await client.get("/system/info");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, { dispatcher?: unknown }];
    expect(options.dispatcher).toBeInstanceOf(Agent);
  });

  it("only the relaxed client instance carries a custom dispatcher", async () => {
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
    // Only the self-hosted client's request carries the relaxed dispatcher;
    // the cloud client uses Node's default -- no shared/global toggle.
    expect(dispatchers[0]).toBeInstanceOf(Agent);
    expect(dispatchers[1]).toBeUndefined();
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });
});
