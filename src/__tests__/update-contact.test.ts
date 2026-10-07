/**
 * WYREAI-434: cw_update_contact JSON Patch and cw_update_contact_types
 * (Decision Maker and other contact-type associations).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";
import {
  CONTACT_TYPE_PATCH_ERROR,
  assertContactPatchOperations,
  contactTypeNameCondition,
  pickContactType,
} from "../tools/contact-type-update.js";

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

function toolError(body: Record<string, unknown>): string {
  const result = body.result as { content?: { text?: string }[]; isError?: boolean } | undefined;
  expect(result?.isError).toBe(true);
  return result?.content?.[0]?.text ?? "";
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const contactPatch = [
  { op: "replace", path: "firstName", value: "Ada" },
  { op: "replace", path: "lastName", value: "Lovelace" },
  { op: "replace", path: "title", value: "Owner" },
  { op: "replace", path: "inactiveFlag", value: false },
  { op: "replace", path: "site", value: { id: 7 } },
  {
    op: "replace",
    path: "communicationItems",
    value: [
      { type: { name: "Email" }, value: "ada@example.com", communicationType: "Email", defaultFlag: true },
      { type: { name: "Direct" }, value: "555-0100", communicationType: "Phone" },
    ],
  },
  { op: "replace", path: "customFields", value: [{ id: 3, value: "VIP" }] },
];

describe("contact patch helpers", () => {
  it("rejects type paths and leaves other contact fields alone", () => {
    expect(() => assertContactPatchOperations([{ path: "types" }])).toThrow(CONTACT_TYPE_PATCH_ERROR);
    expect(() => assertContactPatchOperations([{ path: "/typeIds/0" }])).toThrow(CONTACT_TYPE_PATCH_ERROR);
    expect(() => assertContactPatchOperations([{ path: "firstName" }, { path: "communicationItems" }])).not.toThrow();
  });

  it("quotes contact type names for Manage conditions", () => {
    expect(contactTypeNameCondition("Decision Maker")).toBe('name = "Decision Maker"');
    expect(contactTypeNameCondition('Say "Hi"')).toBe('name = "Say \\"Hi\\""');
  });

  it("picks a single contact type by name", () => {
    expect(pickContactType([{ id: 5, name: "Decision Maker" }, { id: 2, name: "Primary" }], "decision maker")).toEqual({
      id: 5,
      name: "Decision Maker",
    });
    expect(() => pickContactType([], "Decision Maker")).toThrow(/No contact type named/);
  });
});

describe("cw_update_contact", () => {
  it("exposes contact update tools without dropping the existing contact tools", async () => {
    const body = await mcp("tools/list", {});
    const tools = (body.result as { tools: { name: string }[] }).tools;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "cw_search_contacts",
        "cw_get_contact",
        "cw_create_contact",
        "cw_update_contact",
        "cw_update_contact_types",
        "cw_update_agreement_addition",
        "cw_search_schedule_entries",
        "cw_create_schedule_entry",
        "cw_list_warehouses",
        "cw_get_inventory_on_hand",
        "cw_close_adjustment",
      ]),
    );
    expect(names).toHaveLength(72);
  });

  it("patches name, title, site, inactive flag, communication items, and custom fields", async () => {
    const updatedContact = { id: 42, firstName: "Ada", title: "Owner", inactiveFlag: false };
    const fetchMock = vi.fn().mockResolvedValueOnce(fakeResponse(updatedContact));
    vi.stubGlobal("fetch", fetchMock);

    const updated = await mcp("tools/call", {
      name: "cw_update_contact",
      arguments: { id: 42, operations: contactPatch },
    });

    expect(JSON.parse(toolText(updated))).toEqual(updatedContact);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toContain("/company/contacts/42");
    expect(url).not.toContain("typeAssociations");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual(contactPatch);
  });

  it("returns the Manage error for an invalid contact id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      fakeResponse({ code: "NotFound", message: "Contact not found" }, 404),
    );
    vi.stubGlobal("fetch", fetchMock);

    const body = await mcp("tools/call", {
      name: "cw_update_contact",
      arguments: {
        id: 999999,
        operations: [{ op: "replace", path: "title", value: "Owner" }],
      },
    });

    const message = toolError(body);
    expect(message).toMatch(/ConnectWise API PATCH \/company\/contacts\/999999 returned 404/);
    expect(message).toMatch(/Contact not found/);
  });

  it("rejects an add/replace operation missing value and does not call Manage", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const body = await mcp("tools/call", {
      name: "cw_update_contact",
      arguments: {
        id: 42,
        operations: [{ op: "replace", path: "title" }],
      },
    });

    expect(toolError(body)).toMatch(/value is required/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to patch contact types and points at cw_update_contact_types", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const body = await mcp("tools/call", {
      name: "cw_update_contact",
      arguments: {
        id: 42,
        operations: [{ op: "replace", path: "types", value: [{ id: 5 }] }],
      },
    });

    expect(toolError(body)).toMatch(/cw_update_contact_types/);
    expect(toolError(body)).toMatch(/Decision Maker/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cw_update_contact_types", () => {
  it("tags a contact as Decision Maker", async () => {
    const created = {
      id: 90,
      type: { id: 5, name: "Decision Maker" },
      contact: { id: 42 },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse([{ id: 5, name: "Decision Maker" }]))
      .mockResolvedValueOnce(fakeResponse([]))
      .mockResolvedValueOnce(fakeResponse(created));
    vi.stubGlobal("fetch", fetchMock);

    const body = await mcp("tools/call", {
      name: "cw_update_contact_types",
      arguments: { id: 42, action: "add", typeName: "Decision Maker" },
    });

    expect(JSON.parse(toolText(body))).toEqual({
      action: "add",
      alreadyAssigned: false,
      contactId: 42,
      association: created,
    });

    const [typesUrl] = fetchMock.mock.calls[0] as [string];
    expect(typesUrl).toContain("/company/contacts/types");
    expect(new URL(typesUrl).searchParams.get("conditions")).toBe('name = "Decision Maker"');

    const [listUrl, listInit] = fetchMock.mock.calls[1] as [string, { method?: string }];
    expect(listUrl).toContain("/company/contacts/42/typeAssociations");
    expect(listInit.method ?? "GET").toBe("GET");

    const [postUrl, postInit] = fetchMock.mock.calls[2] as [string, { method: string; body: string }];
    expect(postUrl).toContain("/company/contacts/42/typeAssociations");
    expect(postInit.method).toBe("POST");
    expect(JSON.parse(postInit.body)).toEqual({ type: { id: 5 }, contact: { id: 42 } });
  });

  it("does not duplicate a type the contact already has", async () => {
    const existing = { id: 90, type: { id: 5, name: "Decision Maker" }, contact: { id: 42 } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse([{ id: 5, name: "Decision Maker" }]))
      .mockResolvedValueOnce(fakeResponse([existing]));
    vi.stubGlobal("fetch", fetchMock);

    const body = await mcp("tools/call", {
      name: "cw_update_contact_types",
      arguments: { id: 42, action: "add", typeName: "Decision Maker" },
    });

    expect(JSON.parse(toolText(body))).toEqual({
      action: "add",
      alreadyAssigned: true,
      contactId: 42,
      association: existing,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every((call) => (call[1] as { method?: string }).method !== "POST")).toBe(true);
  });

  it("returns the Manage error when the contact id does not exist", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      fakeResponse({ code: "NotFound", message: "Contact not found" }, 404),
    );
    vi.stubGlobal("fetch", fetchMock);

    const body = await mcp("tools/call", {
      name: "cw_update_contact_types",
      arguments: { id: 999999, action: "add", typeId: 5 },
    });

    expect(toolError(body)).toMatch(
      /ConnectWise API GET \/company\/contacts\/999999\/typeAssociations returned 404/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes a type by name", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse([{ id: 5, name: "Decision Maker" }]))
      .mockResolvedValueOnce(fakeResponse([{ id: 90, type: { id: 5, name: "Decision Maker" } }]))
      .mockResolvedValueOnce(fakeResponse(undefined, 204));
    vi.stubGlobal("fetch", fetchMock);

    const body = await mcp("tools/call", {
      name: "cw_update_contact_types",
      arguments: { id: 42, action: "remove", typeName: "Decision Maker" },
    });

    expect(JSON.parse(toolText(body))).toEqual({
      action: "remove",
      removed: true,
      contactId: 42,
      associationIds: [90],
    });
    const [deleteUrl, deleteInit] = fetchMock.mock.calls[2] as [string, { method: string }];
    expect(deleteUrl).toContain("/company/contacts/42/typeAssociations/90");
    expect(deleteInit.method).toBe("DELETE");
  });

  it("requires a type when adding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const body = await mcp("tools/call", {
      name: "cw_update_contact_types",
      arguments: { id: 42, action: "add" },
    });

    expect(toolError(body)).toMatch(/requires typeId or typeName/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
