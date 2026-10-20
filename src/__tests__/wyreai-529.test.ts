/**
 * WYREAI-529: cw_create_contact resolves communication types per tenant
 * instead of hardcoding "Email" / "Direct".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../worker.js";
import {
  clearCommunicationTypeCache,
  pickEmailType,
  pickPhoneType,
} from "../tools/communication-types.js";

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

async function mcp(
  method: string,
  params: unknown,
  headers: Record<string, string> = GATEWAY_HEADERS,
): Promise<Record<string, unknown>> {
  const res = await worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
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

function toolError(body: Record<string, unknown>): string {
  const result = body.result as { content?: { text?: string }[]; isError?: boolean } | undefined;
  expect(result?.isError).toBe(true);
  return result?.content?.[0]?.text ?? "";
}

const TYPES = [
  { id: 1, description: "Work Email", emailFlag: true, phoneFlag: false, defaultFlag: false },
  { id: 2, description: "E-Mail", emailFlag: true, phoneFlag: false, defaultFlag: true },
  { id: 3, description: "Office", emailFlag: false, phoneFlag: true, defaultFlag: true },
  { id: 4, description: "Mobile", emailFlag: false, phoneFlag: true, defaultFlag: false },
  { id: 5, description: "Fax", faxFlag: true },
];

function create(args: Record<string, unknown>, headers?: Record<string, string>) {
  return mcp(
    "tools/call",
    { name: "cw_create_contact", arguments: { firstName: "Ada", lastName: "L", companyId: 7, ...args } },
    headers,
  );
}

/** Routes GETs on communicationTypes to `types`, POSTs to a canned contact. */
function stubFetch(types: unknown[] = TYPES) {
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    if (init?.method === "POST") return fakeResponse({ id: 99 });
    if (String(url).includes("/company/communicationTypes")) return fakeResponse(types);
    return fakeResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const typeCalls = (m: ReturnType<typeof stubFetch>) =>
  m.mock.calls.filter(([u]) => String(u).includes("/company/communicationTypes"));
const postCalls = (m: ReturnType<typeof stubFetch>) =>
  m.mock.calls.filter(([, i]) => (i as { method?: string } | undefined)?.method === "POST");
const postBody = (m: ReturnType<typeof stubFetch>) =>
  JSON.parse((postCalls(m)[0][1] as { body: string }).body);

beforeEach(() => clearCommunicationTypeCache());
afterEach(() => vi.unstubAllGlobals());

describe("communication type pickers", () => {
  it("prefers emailFlag, then default, then Email, then lowest id", () => {
    expect(pickEmailType(TYPES)).toEqual({ id: 2, name: "E-Mail" });
    expect(
      pickEmailType([
        { id: 9, description: "Other", emailFlag: true },
        { id: 8, description: "email", emailFlag: true },
      ]),
    ).toEqual({ id: 8, name: "email" });
    expect(pickEmailType([{ id: 4, description: "E-mail" }])).toEqual({ id: 4, name: "E-mail" });
    expect(pickEmailType([{ id: 4, description: "Fax" }])).toBeUndefined();
  });

  it("prefers phoneFlag with Direct, then default; tolerates name", () => {
    expect(pickPhoneType(TYPES)).toEqual({ id: 3, name: "Office" });
    expect(
      pickPhoneType([
        { id: 1, description: "Mobile", phoneFlag: true, defaultFlag: true },
        { id: 2, description: "direct", phoneFlag: true },
      ]),
    ).toEqual({ id: 2, name: "direct" });
    expect(pickPhoneType([{ id: 6, name: "Phone" }])).toEqual({ id: 6, name: "Phone" });
  });
});

describe("cw_create_contact communication types", () => {
  it("registers cw_list_communication_types", async () => {
    const body = await mcp("tools/list", {});
    const names = (body.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toContain("cw_list_communication_types");
  });

  it("resolves email via emailFlag when no type is named Email", async () => {
    const f = stubFetch();
    toolText(await create({ email: "ada@example.com" }));
    expect(postBody(f).communicationItems).toEqual([
      { type: { id: 2, name: "E-Mail" }, value: "ada@example.com", communicationType: "Email" },
    ]);
  });

  it("resolves phone via phoneFlag when Direct is absent", async () => {
    const f = stubFetch();
    toolText(await create({ phone: "555-0100" }));
    expect(postBody(f).communicationItems).toEqual([
      { type: { id: 3, name: "Office" }, value: "555-0100", communicationType: "Phone" },
    ]);
  });

  it("uses caller ids without any lookup, id winning over name", async () => {
    const f = stubFetch();
    toolText(
      await create({
        email: "a@b.co",
        phone: "1",
        emailTypeId: 11,
        emailTypeName: "Work Email",
        phoneTypeId: 12,
      }),
    );
    expect(typeCalls(f)).toHaveLength(0);
    expect(postBody(f).communicationItems).toEqual([
      { type: { id: 11 }, value: "a@b.co", communicationType: "Email" },
      { type: { id: 12 }, value: "1", communicationType: "Phone" },
    ]);
  });

  it("resolves a caller-supplied name case-insensitively", async () => {
    const f = stubFetch();
    toolText(await create({ email: "a@b.co", emailTypeName: "work email" }));
    expect(postBody(f).communicationItems[0].type).toEqual({ id: 1, name: "Work Email" });
  });

  it("matches a caller name only against types of the requested kind", async () => {
    const f = stubFetch();
    // "Office" is a phone type in the fixture, so it must not be used for email.
    const msg = toolError(await create({ email: "a@b.co", emailTypeName: "Office" }));
    expect(msg).toMatch(/No email communication type named "Office"/);
    expect(postCalls(f)).toHaveLength(0);
  });

  it("errors on an unknown caller name, listing available types, and does not POST", async () => {
    const f = stubFetch();
    const msg = toolError(await create({ email: "a@b.co", emailTypeName: "Nope" }));
    expect(msg).toMatch(/No email communication type named "Nope"/);
    expect(msg).toMatch(/1 \(Work Email\), 2 \(E-Mail\)/);
    expect(msg).not.toMatch(/Office/);
    expect(postCalls(f)).toHaveLength(0);
  });

  it("errors clearly when the tenant has no email type, and does not POST", async () => {
    const f = stubFetch([{ id: 3, description: "Office", phoneFlag: true }]);
    const msg = toolError(await create({ email: "a@b.co" }));
    expect(msg).toMatch(/No email communication type found in ConnectWise/);
    expect(msg).toMatch(/Pass emailTypeId or emailTypeName/);
    expect(msg).toMatch(/3 \(Office\)/);
    expect(postCalls(f)).toHaveLength(0);
  });

  it("does not look up types when there is no email or phone", async () => {
    const f = stubFetch();
    toolText(await create({}));
    expect(typeCalls(f)).toHaveLength(0);
    expect(postBody(f).communicationItems).toBeUndefined();
  });

  it("does not look up types for a type name whose value is not provided", async () => {
    const f = stubFetch();
    toolText(await create({ email: "a@b.co", emailTypeId: 5, phoneTypeName: "Mobile" }));
    // phone name given but no phone number: nothing to resolve
    expect(typeCalls(f)).toHaveLength(0);
  });

  it("fetches the type list once per connection and again for another company", async () => {
    const f = stubFetch();
    toolText(await create({ email: "a@b.co" }));
    toolText(await create({ email: "c@d.co", phone: "1" }));
    expect(typeCalls(f)).toHaveLength(1);
    expect(String(typeCalls(f)[0][0])).toContain("pageSize=1000");

    toolText(await create({ email: "e@f.co" }, { ...GATEWAY_HEADERS, "X-CW-Company-Id": "other" }));
    expect(typeCalls(f)).toHaveLength(2);
  });
});
