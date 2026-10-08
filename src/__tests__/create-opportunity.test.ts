/**
 * cw_create_opportunity, cw_add_opportunity_note and the opportunity
 * status/type lookup tools.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";
import { buildOpportunityPayload, toCwDate } from "../tools/opportunities.js";

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
    text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

async function mcp(method: string, params: unknown, id = 1): Promise<Record<string, unknown>> {
  const res = await worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: GATEWAY_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
    { AUTH_MODE: "gateway" },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function toolText(body: Record<string, unknown>): string {
  const result = body.result as { content?: { text?: string }[]; isError?: boolean } | undefined;
  expect(result?.isError).not.toBe(true);
  return result?.content?.[0]?.text ?? "";
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toCwDate", () => {
  it("expands date-only values and leaves full timestamps alone", () => {
    expect(toCwDate("2026-12-31")).toBe("2026-12-31T00:00:00Z");
    expect(toCwDate("2026-12-31T10:00:00Z")).toBe("2026-12-31T10:00:00Z");
  });
});

describe("buildOpportunityPayload", () => {
  it("skips the company lookup when contact and site are given", async () => {
    const get = vi.fn();
    const body = await buildOpportunityPayload({ get } as never, {
      name: "Firewall refresh",
      companyId: 250,
      contactId: 7,
      siteId: 3,
      primarySalesRepIdentifier: "jdoe",
    });
    expect(get).not.toHaveBeenCalled();
    expect(body).toEqual({
      name: "Firewall refresh",
      company: { id: 250 },
      contact: { id: 7 },
      site: { id: 3 },
      primarySalesRep: { identifier: "jdoe" },
    });
  });

  it("prefers primarySalesRepId over identifier", async () => {
    const body = await buildOpportunityPayload({ get: vi.fn() } as never, {
      name: "X",
      companyId: 1,
      contactId: 2,
      siteId: 3,
      primarySalesRepId: 44,
      primarySalesRepIdentifier: "ignored",
    });
    expect(body.primarySalesRep).toEqual({ id: 44 });
  });

  it("rejects a payload with no primary sales rep", async () => {
    await expect(
      buildOpportunityPayload({ get: vi.fn() } as never, {
        name: "X",
        companyId: 1,
        contactId: 2,
        siteId: 3,
      })
    ).rejects.toThrow(/primary sales rep/);
  });
});

describe("opportunity create tools", () => {
  it("exposes the new tools", async () => {
    const body = await mcp("tools/list", {});
    const tools = (body.result as { tools: { name: string; inputSchema?: { required?: string[] } }[] }).tools;
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName.cw_create_opportunity).toBeDefined();
    expect(byName.cw_create_opportunity.inputSchema?.required).toEqual(["name", "companyId"]);
    expect(byName.cw_add_opportunity_note).toBeDefined();
    expect(byName.cw_list_opportunity_statuses).toBeDefined();
    expect(byName.cw_list_opportunity_types).toBeDefined();
  });

  it("fills contact and site from the company, then POSTs the opportunity", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ id: 250, defaultContact: { id: 9 }, site: { id: 4 } }))
      .mockResolvedValueOnce(fakeResponse({ id: 1001, name: "M365 migration" }, 201));
    vi.stubGlobal("fetch", fetchMock);

    const res = await mcp("tools/call", {
      name: "cw_create_opportunity",
      arguments: {
        name: "M365 migration",
        companyId: 250,
        primarySalesRepId: 12,
        expectedCloseDate: "2026-12-15",
        stageId: 2,
        statusId: 1,
        typeId: 3,
        notes: "Inbound from website",
      },
    });

    expect(JSON.parse(toolText(res))).toEqual({ id: 1001, name: "M365 migration" });
    const [companyUrl] = fetchMock.mock.calls[0] as [string];
    expect(companyUrl).toContain("/company/companies/250");
    const [url, init] = fetchMock.mock.calls[1] as [string, { method: string; body: string }];
    expect(url).toContain("/sales/opportunities");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      name: "M365 migration",
      company: { id: 250 },
      contact: { id: 9 },
      site: { id: 4 },
      primarySalesRep: { id: 12 },
      expectedCloseDate: "2026-12-15T00:00:00Z",
      stage: { id: 2 },
      status: { id: 1 },
      type: { id: 3 },
      notes: "Inbound from website",
    });
  });

  it("dryRun returns the payload without POSTing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await mcp("tools/call", {
      name: "cw_create_opportunity",
      arguments: { name: "Preview", companyId: 5, contactId: 6, siteId: 7, primarySalesRepId: 12, dryRun: true },
    });

    const parsed = JSON.parse(toolText(res));
    expect(parsed.dryRun).toBe(true);
    expect(parsed.body).toEqual({
      name: "Preview",
      company: { id: 5 },
      contact: { id: 6 },
      site: { id: 7 },
      primarySalesRep: { id: 12 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds a note to an opportunity", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fakeResponse({ id: 55, text: "Called client" }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await mcp("tools/call", {
      name: "cw_add_opportunity_note",
      arguments: { opportunityId: 1001, text: "Called client", flagged: true },
    });

    expect(JSON.parse(toolText(res)).id).toBe(55);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toContain("/sales/opportunities/1001/notes");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ text: "Called client", flagged: true });
  });
});
