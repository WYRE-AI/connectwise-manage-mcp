/**
 * WYREAI-705: onboarding and ticket-creation depth.
 * cw_list_company_sites, siteId on cw_create_contact, and the siteId /
 * ownerId / automaticEmail* opt-ins on cw_create_ticket.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../worker.js";

const GATEWAY_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "X-CW-Company-Id": "acme",
  "X-CW-Public-Key": "pub",
  "X-CW-Private-Key": "priv",
  "X-CW-Client-Id": "client-guid",
};

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const res = await worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: GATEWAY_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    { AUTH_MODE: "gateway" },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: { isError?: boolean; content?: { text?: string }[] } };
}

type FetchCall = [string, { method?: string; body?: string } | undefined];

function stubFetch(handler: (url: string, init?: { method?: string }) => unknown) {
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) =>
    fakeResponse(handler(String(url), init)),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const posts = (m: ReturnType<typeof stubFetch>) =>
  (m.mock.calls as unknown as FetchCall[]).filter(([, init]) => init?.method === "POST");

describe("WYREAI-705", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("cw_list_company_sites reads the company's sites collection", async () => {
    const m = stubFetch(() => [{ id: 3, name: "Main", defaultFlag: true }]);
    const out = await callTool("cw_list_company_sites", { companyId: 7, conditions: "inactiveFlag = false" });
    expect(out.result?.isError).not.toBe(true);
    const [url] = m.mock.calls[0] as unknown as FetchCall;
    expect(url).toContain("/company/companies/7/sites");
    expect(url).toContain("pageSize=100");
    expect(new URL(url).searchParams.get("conditions")).toBe("inactiveFlag = false");
  });

  it("cw_create_contact sends site.id only when siteId is given", async () => {
    const m = stubFetch(() => ({ id: 99 }));
    await callTool("cw_create_contact", { firstName: "Ada", lastName: "L", companyId: 7, siteId: 12 });
    expect(JSON.parse(posts(m)[0][1]!.body!)).toMatchObject({ company: { id: 7 }, site: { id: 12 } });

    const m2 = stubFetch(() => ({ id: 99 }));
    await callTool("cw_create_contact", { firstName: "Ada", lastName: "L", companyId: 7 });
    expect(JSON.parse(posts(m2)[0][1]!.body!)).not.toHaveProperty("site");
  });

  it("cw_create_ticket sends site, owner and email flags only when set", async () => {
    const m = stubFetch(() => ({ id: 1 }));
    await callTool("cw_create_ticket", {
      summary: "VPN down",
      companyId: 7,
      siteId: 12,
      ownerId: 5,
      automaticEmailContactFlag: false,
      automaticEmailResourceFlag: false,
      automaticEmailCcFlag: false,
    });
    expect(JSON.parse(posts(m)[0][1]!.body!)).toEqual({
      summary: "VPN down",
      company: { id: 7 },
      site: { id: 12 },
      owner: { id: 5 },
      automaticEmailContactFlag: false,
      automaticEmailResourceFlag: false,
      automaticEmailCcFlag: false,
    });

    const m2 = stubFetch(() => ({ id: 1 }));
    await callTool("cw_create_ticket", { summary: "VPN down" });
    expect(JSON.parse(posts(m2)[0][1]!.body!)).toEqual({ summary: "VPN down" });
  });
});
