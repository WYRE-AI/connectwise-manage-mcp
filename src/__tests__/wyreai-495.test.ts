/**
 * WYREAI-495: time-entry email flags must not default on, and ticket-note
 * email field names must not be posted on ServiceNote (that 400s).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";
import { buildTicketNoteBody, SERVICE_NOTE_REJECTED_EMAIL_FIELDS } from "../tools/note-payload.js";
import { buildCreateTimeEntryBody } from "../tools/time-entries.js";

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
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
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

function toolResult(body: Record<string, unknown>): { text: string; isError?: boolean } {
  const result = body.result as { content?: { text?: string }[]; isError?: boolean } | undefined;
  return { text: result?.content?.[0]?.text ?? "", isError: result?.isError };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseEntry = {
  chargeToType: "ServiceTicket" as const,
  chargeToId: 42,
  memberId: 7,
  timeStart: "2026-10-13T15:00:00Z",
};

describe("time entry email defaults (WYREAI-495)", () => {
  it("sends every email flag false when the caller omits them", () => {
    const body = buildCreateTimeEntryBody(baseEntry);
    expect(body.emailContactFlag).toBe(false);
    expect(body.emailResourceFlag).toBe(false);
    expect(body.emailCcFlag).toBe(false);
    expect(body).not.toHaveProperty("emailCc");
  });

  it("sends true only for flags the caller sets, and sends emailCc only when provided", () => {
    expect(
      buildCreateTimeEntryBody({
        ...baseEntry,
        emailContactFlag: true,
        emailCc: "billing@example.com",
      }),
    ).toMatchObject({
      emailContactFlag: true,
      emailResourceFlag: false,
      emailCcFlag: false,
      emailCc: "billing@example.com",
    });
  });

  it("posts false email flags from cw_create_time_entry when none are passed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ id: 9 }));
    vi.stubGlobal("fetch", fetchMock);

    const body = await mcp("tools/call", {
      name: "cw_create_time_entry",
      arguments: baseEntry,
    });
    expect(toolResult(body).isError).not.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toContain("/time/entries");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      chargeToType: "ServiceTicket",
      chargeToId: 42,
      member: { id: 7 },
      timeStart: "2026-10-13T15:00:00Z",
      emailContactFlag: false,
      emailResourceFlag: false,
      emailCcFlag: false,
    });
  });

  it("describes the time-entry flags as defaulting false", async () => {
    const body = await mcp("tools/list", {});
    const tools = (body.result as { tools: { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }[] }).tools;
    const tool = tools.find((entry) => entry.name === "cw_create_time_entry");
    expect(tool?.description).toMatch(/never defaults them to true/i);
    for (const field of ["emailContactFlag", "emailResourceFlag", "emailCcFlag", "emailCc"]) {
      expect(tool?.inputSchema?.properties).toHaveProperty(field);
    }
  });
});

describe("ticket note email payload (WYREAI-495)", () => {
  it("never places TimeEntry email fields on a ServiceNote", () => {
    const body = buildTicketNoteBody({
      text: "hello",
      emailContactFlag: true,
      emailResourceFlag: true,
      emailCcFlag: true,
      emailCc: "a@example.com",
      detailDescriptionFlag: true,
    });
    for (const field of SERVICE_NOTE_REJECTED_EMAIL_FIELDS) {
      expect(body).not.toHaveProperty(field);
    }
    expect(body.processNotifications).toBe(true);
  });

  it("adds a discussion flag only when notifying and the caller set no type flag", () => {
    expect(buildTicketNoteBody({ text: "ping", emailContactFlag: true })).toEqual({
      text: "ping",
      processNotifications: true,
      detailDescriptionFlag: true,
    });
    expect(
      buildTicketNoteBody({
        text: "staff",
        emailResourceFlag: true,
        internalAnalysisFlag: true,
      }),
    ).toEqual({
      text: "staff",
      internalAnalysisFlag: true,
      processNotifications: true,
    });
  });

  it("sends member.id only when memberId is set", () => {
    expect(buildTicketNoteBody({ text: "anon" })).not.toHaveProperty("member");
    expect(buildTicketNoteBody({ text: "signed", memberId: 42 }).member).toEqual({ id: 42 });
  });

  it("posts a note with emailContactFlag true as processNotifications and no email field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ id: 5, text: "hi" }));
    vi.stubGlobal("fetch", fetchMock);

    const body = await mcp("tools/call", {
      name: "cw_add_ticket_note",
      arguments: { id: 100, text: "hi", emailContactFlag: true },
    });
    expect(toolResult(body).isError).not.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toContain("/service/tickets/100/notes");
    expect(JSON.parse(init.body)).toEqual({
      text: "hi",
      processNotifications: true,
      detailDescriptionFlag: true,
    });
  });

  it("posts emailCcFlag plus emailCc without those fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ id: 6, text: "cc" }));
    vi.stubGlobal("fetch", fetchMock);

    await mcp("tools/call", {
      name: "cw_add_ticket_note",
      arguments: {
        id: 100,
        text: "cc",
        emailCcFlag: true,
        emailCc: "billing@example.com",
        detailDescriptionFlag: true,
      },
    });

    const posted = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body) as Record<string, unknown>;
    expect(posted).toEqual({
      text: "cc",
      detailDescriptionFlag: true,
      processNotifications: true,
    });
  });

  it("sends member only when the caller sets memberId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ id: 7, text: "by member" }));
    vi.stubGlobal("fetch", fetchMock);

    await mcp("tools/call", {
      name: "cw_add_ticket_note",
      arguments: { id: 100, text: "by member", memberId: 88, internalAnalysisFlag: true },
    });

    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body)).toEqual({
      text: "by member",
      internalAnalysisFlag: true,
      member: { id: 88 },
    });
  });

  it("returns a project-note ConnectWise 400 body on the tool error", async () => {
    const cwBody = JSON.stringify({
      code: "InvalidObject",
      message: "ticketNote object is invalid",
      errors: [{ message: "member id 999 was not found" }],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(cwBody, 400)));

    const body = await mcp("tools/call", {
      name: "cw_add_project_ticket_note",
      arguments: { id: 50, text: "project note", memberId: 999 },
    });
    const result = toolResult(body);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/returned 400 \(reference [0-9a-f-]{36}\):/);
    expect(result.text).toContain("/project/tickets/50/notes");
    expect(result.text).toContain("ticketNote object is invalid");
  });

  it("returns the ConnectWise 400 body on the tool error", async () => {
    const cwBody = JSON.stringify({
      code: "InvalidObject",
      message: "serviceNote object is invalid",
      errors: [{ code: "ServiceNote", message: "Please choose where to display the notes in order to save this record.", field: "detailDescriptionFlag, internalAnalysisFlag, resolutionFlag" }],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(cwBody, 400)));

    const body = await mcp("tools/call", {
      name: "cw_add_ticket_note",
      arguments: { id: 100, text: "hi", internalAnalysisFlag: true },
    });
    const result = toolResult(body);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/returned 400 \(reference [0-9a-f-]{36}\):/);
    expect(result.text).toContain("serviceNote object is invalid");
    expect(result.text).toContain("Please choose where to display the notes");
  });
});
