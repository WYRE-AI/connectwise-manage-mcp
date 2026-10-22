/**
 * WYREAI-495: time-entry email flags must not default on, and ticket-note
 * email field names must not be posted on ServiceNote (that 400s).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";
import { buildTicketNoteBody, SERVICE_NOTE_REJECTED_EMAIL_FIELDS } from "../tools/note-payload.js";
import {
  buildCreateTimeEntryBody,
  activeTicketLockCount,
  createTimeEntryWithEmailGuard,
  withTicketLock,
  type TimeEntryClient,
} from "../tools/time-entries.js";

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

    // The ticket GET comes first; the mock's ticket has no automaticEmail* flags on.
    const calls = fetchMock.mock.calls as [string, { method: string; body: string }][];
    const [url, init] = calls.find(([, call]) => call.method === "POST")!;
    expect(url).toContain("/time/entries");
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

  it("describes the ticket flag toggle, not a per-entry email override", async () => {
    const body = await mcp("tools/list", {});
    const tools = (body.result as { tools: { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }[] }).tools;
    const tool = tools.find((entry) => entry.name === "cw_create_time_entry");
    expect(tool?.description).not.toMatch(/never defaults them to true/i);
    expect(tool?.description).toMatch(/copies the ticket's automaticEmailContactFlag/);
    expect(tool?.description).toMatch(/not created/);
    expect(tool?.description).toMatch(/suppressTicketAutoEmail=false/);
    for (const field of ["emailContactFlag", "emailResourceFlag", "emailCcFlag", "emailCc", "suppressTicketAutoEmail"]) {
      expect(tool?.inputSchema?.properties).toHaveProperty(field);
    }
  });
});

interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

type Route = (call: RecordedCall) => Response | undefined;

/** Routes fetch by method + path; records every call in order. */
function routedFetch(routes: Record<string, Route | unknown>) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn((url: string, init: { method: string; body?: string }) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^.*\/apis\/3\.0/, "");
    const call: RecordedCall = {
      method: init.method,
      path,
      query: Object.fromEntries(parsed.searchParams),
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const key = `${init.method} ${path}`;
    const route = routes[key];
    if (route === undefined) return Promise.resolve(fakeResponse({ message: `unrouted ${key}` }, 500));
    if (typeof route === "function") {
      const response = (route as Route)(call);
      if (response) return Promise.resolve(response);
      return Promise.resolve(fakeResponse({}));
    }
    return Promise.resolve(fakeResponse(route));
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** Answers PATCH with a sequence of statuses (one per call). */
function patchSequence(...statuses: number[]): Route {
  let i = 0;
  return () => {
    const status = statuses[Math.min(i++, statuses.length - 1)];
    return status === 200
      ? fakeResponse({ id: 42 })
      : fakeResponse({ code: "Forbidden", message: "You do not have permission to edit tickets" }, status);
  };
}

function allText(body: Record<string, unknown>): string[] {
  const result = body.result as { content?: { text?: string }[] };
  return (result.content ?? []).map((item) => item.text ?? "");
}

const TICKET_FIELDS = "automaticEmailContactFlag,automaticEmailResourceFlag,automaticEmailCcFlag";
const createdEntry = { id: 6188, emailContactFlag: false, emailResourceFlag: false, emailCcFlag: false };

describe("cw_create_time_entry ticket auto-email guard (WYREAI-495)", () => {
  for (const [label, extra] of [
    ["entry flag unset", {}],
    ["entry flag explicit false", { emailContactFlag: false }],
  ] as const) {
    it(`turns the ticket contact flag off around the create (${label})`, async () => {
      const calls = routedFetch({
        "GET /service/tickets/42": { automaticEmailContactFlag: true, automaticEmailResourceFlag: false, automaticEmailCcFlag: false },
        "PATCH /service/tickets/42": { id: 42 },
        "POST /time/entries": createdEntry,
      });

      const body = await mcp("tools/call", { name: "cw_create_time_entry", arguments: { ...baseEntry, ...extra } });
      expect(toolResult(body).isError).not.toBe(true);
      expect(JSON.parse(toolResult(body).text)).toEqual(createdEntry);

      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        "GET /service/tickets/42",
        "PATCH /service/tickets/42",
        "POST /time/entries",
        "PATCH /service/tickets/42",
      ]);
      expect(calls[0].query.fields).toBe(TICKET_FIELDS);
      expect(calls[1].body).toEqual([{ op: "replace", path: "automaticEmailContactFlag", value: false }]);
      expect((calls[2].body as Record<string, unknown>).emailContactFlag).toBe(false);
      expect(calls[3].body).toEqual([{ op: "replace", path: "automaticEmailContactFlag", value: true }]);
    });
  }

  it("patches only the ticket flags that are on and whose entry flag is false", async () => {
    const calls = routedFetch({
      "GET /service/tickets/42": { automaticEmailContactFlag: true, automaticEmailResourceFlag: false, automaticEmailCcFlag: true },
      "PATCH /service/tickets/42": { id: 42 },
      "POST /time/entries": createdEntry,
    });

    await mcp("tools/call", { name: "cw_create_time_entry", arguments: baseEntry });

    expect(calls[1].body).toEqual([
      { op: "replace", path: "automaticEmailContactFlag", value: false },
      { op: "replace", path: "automaticEmailCcFlag", value: false },
    ]);
    expect(calls[3].body).toEqual([
      { op: "replace", path: "automaticEmailContactFlag", value: true },
      { op: "replace", path: "automaticEmailCcFlag", value: true },
    ]);
  });

  it("does not patch the ticket when its flags are off", async () => {
    const calls = routedFetch({
      "GET /service/tickets/42": { automaticEmailContactFlag: false, automaticEmailResourceFlag: false, automaticEmailCcFlag: false },
      "POST /time/entries": createdEntry,
    });

    const body = await mcp("tools/call", { name: "cw_create_time_entry", arguments: baseEntry });
    expect(toolResult(body).isError).not.toBe(true);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /service/tickets/42", "POST /time/entries"]);
  });

  it("leaves a flag alone when the caller asks for that email", async () => {
    const calls = routedFetch({
      "GET /service/tickets/42": { automaticEmailContactFlag: true, automaticEmailResourceFlag: true, automaticEmailCcFlag: false },
      "PATCH /service/tickets/42": { id: 42 },
      "POST /time/entries": { ...createdEntry, emailContactFlag: true },
    });

    const body = await mcp("tools/call", {
      name: "cw_create_time_entry",
      arguments: { ...baseEntry, emailContactFlag: true },
    });
    expect(toolResult(body).isError).not.toBe(true);
    const patches = calls.filter((call) => call.method === "PATCH");
    expect(patches.map((call) => call.body)).toEqual([
      [{ op: "replace", path: "automaticEmailResourceFlag", value: false }],
      [{ op: "replace", path: "automaticEmailResourceFlag", value: true }],
    ]);
    expect(allText(body)).toHaveLength(1);
  });

  it("makes no PATCH when the caller wants contact email and only the contact flag is on", async () => {
    const calls = routedFetch({
      "GET /service/tickets/42": { automaticEmailContactFlag: true, automaticEmailResourceFlag: false, automaticEmailCcFlag: false },
      "POST /time/entries": { ...createdEntry, emailContactFlag: true },
    });

    await mcp("tools/call", { name: "cw_create_time_entry", arguments: { ...baseEntry, emailContactFlag: true } });
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("returns the entry as a success with a warning, a status block and an error log when every restore attempt fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = routedFetch({
      "GET /service/tickets/42": { automaticEmailContactFlag: true, automaticEmailResourceFlag: false, automaticEmailCcFlag: true },
      "PATCH /service/tickets/42": patchSequence(200, 403),
      "POST /time/entries": createdEntry,
    });

    const body = await mcp("tools/call", { name: "cw_create_time_entry", arguments: baseEntry });
    expect(toolResult(body).isError).not.toBe(true);
    const texts = allText(body);
    expect(texts[0]).toContain("WARNING: time entry 6188 WAS created on ticket 42. Do not create it again.");
    expect(texts[0]).toContain(
      "WARNING: ticket 42 automaticEmailContactFlag left false; turn it back on with cw_update_ticket",
    );
    expect(texts[0]).toContain(
      "WARNING: ticket 42 automaticEmailCcFlag left false; turn it back on with cw_update_ticket",
    );
    expect(texts[0]).toContain("failed after 3 attempts");
    expect(texts[0]).toContain("You do not have permission to edit tickets");
    expect(JSON.parse(texts[1])).toEqual(createdEntry);
    expect(JSON.parse(texts[texts.length - 1])).toEqual({
      timeEntryCreated: true,
      timeEntryId: 6188,
      autoEmailRestoreFailed: true,
      ticketId: 42,
      flagsLeftOff: ["automaticEmailContactFlag", "automaticEmailCcFlag"],
      restoreAttempts: 3,
      restoreWith: "cw_update_ticket",
    });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    // One turn-off plus three restore attempts.
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(4);

    const restoreLogs = errorLog.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes("cw_time_entry_auto_email_restore_failed"));
    expect(restoreLogs).toHaveLength(1);
    const logged = JSON.parse(restoreLogs[0]) as Record<string, unknown>;
    expect(logged).toMatchObject({
      level: "error",
      ticketId: 42,
      ticketPath: "/service/tickets/42",
      flagsLeftOff: ["automaticEmailContactFlag", "automaticEmailCcFlag"],
      timeEntryCreated: true,
      timeEntryId: 6188,
      attempts: 3,
    });
    // No gateway credential header values reach the log.
    for (const secret of ["priv", "client-guid"]) expect(restoreLogs[0]).not.toContain(secret);
    errorLog.mockRestore();
  });

  it("does not create the entry when turning the ticket flag off fails", async () => {
    const calls = routedFetch({
      "GET /service/tickets/42": { automaticEmailContactFlag: true, automaticEmailResourceFlag: false, automaticEmailCcFlag: false },
      "PATCH /service/tickets/42": patchSequence(403, 200),
      "POST /time/entries": createdEntry,
    });

    const body = await mcp("tools/call", { name: "cw_create_time_entry", arguments: baseEntry });
    const result = toolResult(body);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Time entry not created/);
    expect(result.text).toContain("automaticEmailContactFlag");
    expect(result.text).toMatch(/would have emailed/);
    expect(result.text).toContain("You do not have permission to edit tickets");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    // Best-effort restore after a failed pre-toggle.
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /service/tickets/42",
      "PATCH /service/tickets/42",
      "PATCH /service/tickets/42",
    ]);
    expect(calls[2].body).toEqual([{ op: "replace", path: "automaticEmailContactFlag", value: true }]);
  });

  it("does not create the entry when the ticket cannot be read", async () => {
    const calls = routedFetch({
      "GET /service/tickets/42": () => fakeResponse({ code: "NotFound", message: "nope" }, 404),
      "POST /time/entries": createdEntry,
    });

    const body = await mcp("tools/call", { name: "cw_create_time_entry", arguments: baseEntry });
    const result = toolResult(body);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Time entry not created/);
    expect(result.text).toContain("404");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("uses /project/tickets/{id} for a ProjectTicket", async () => {
    const calls = routedFetch({
      "GET /project/tickets/50": { automaticEmailContactFlag: true, automaticEmailResourceFlag: false, automaticEmailCcFlag: false },
      "PATCH /project/tickets/50": { id: 50 },
      "POST /time/entries": createdEntry,
    });

    const body = await mcp("tools/call", {
      name: "cw_create_time_entry",
      arguments: { ...baseEntry, chargeToType: "ProjectTicket", chargeToId: 50 },
    });
    expect(toolResult(body).isError).not.toBe(true);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /project/tickets/50",
      "PATCH /project/tickets/50",
      "POST /time/entries",
      "PATCH /project/tickets/50",
    ]);
    expect(calls[0].query.fields).toBe(TICKET_FIELDS);
  });

  it("names PATCH /project/tickets/{id} when a project ticket restore fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    routedFetch({
      "GET /project/tickets/50": { automaticEmailContactFlag: true, automaticEmailResourceFlag: false, automaticEmailCcFlag: false },
      "PATCH /project/tickets/50": patchSequence(200, 500),
      "POST /time/entries": createdEntry,
    });

    const body = await mcp("tools/call", {
      name: "cw_create_time_entry",
      arguments: { ...baseEntry, chargeToType: "ProjectTicket", chargeToId: 50 },
    });
    expect(toolResult(body).isError).not.toBe(true);
    expect(allText(body)[0]).toContain(
      "WARNING: ticket 50 automaticEmailContactFlag left false; turn it back on with PATCH /project/tickets/50",
    );
  });

  for (const chargeToType of ["ChargeCode", "Activity"] as const) {
    it(`makes no ticket calls for ${chargeToType}`, async () => {
      const calls = routedFetch({ "POST /time/entries": createdEntry });
      const body = await mcp("tools/call", {
        name: "cw_create_time_entry",
        arguments: { ...baseEntry, chargeToType, chargeToId: 3 },
      });
      expect(toolResult(body).isError).not.toBe(true);
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /time/entries"]);
    });
  }

  it("makes no ticket calls when suppressTicketAutoEmail is false", async () => {
    const calls = routedFetch({ "POST /time/entries": createdEntry });
    const body = await mcp("tools/call", {
      name: "cw_create_time_entry",
      arguments: { ...baseEntry, suppressTicketAutoEmail: false },
    });
    expect(toolResult(body).isError).not.toBe(true);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /time/entries"]);
    expect(calls[0].body).not.toHaveProperty("suppressTicketAutoEmail");
  });

  it("warns when ConnectWise stores an email flag other than the one requested", async () => {
    routedFetch({
      "GET /service/tickets/42": { automaticEmailContactFlag: false, automaticEmailResourceFlag: false, automaticEmailCcFlag: false },
      "POST /time/entries": { ...createdEntry, emailContactFlag: true },
    });

    const body = await mcp("tools/call", { name: "cw_create_time_entry", arguments: baseEntry });
    expect(toolResult(body).isError).not.toBe(true);
    const texts = allText(body);
    expect(JSON.parse(texts[0]).id).toBe(6188);
    expect(texts[1]).toContain(
      "ConnectWise stored emailContactFlag=true on time entry 6188 though false was requested; the recipient may have been emailed.",
    );
  });

  it("ignores non-boolean email flags on the returned entry", async () => {
    routedFetch({ "POST /time/entries": { id: 6189, emailContactFlag: null } });
    const body = await mcp("tools/call", {
      name: "cw_create_time_entry",
      arguments: { ...baseEntry, chargeToType: "ChargeCode" },
    });
    expect(allText(body)).toHaveLength(1);
  });

  it("restores the ticket flag and returns the POST error when the create fails", async () => {
    const calls = routedFetch({
      "GET /service/tickets/42": { automaticEmailContactFlag: true, automaticEmailResourceFlag: false, automaticEmailCcFlag: false },
      "PATCH /service/tickets/42": { id: 42 },
      "POST /time/entries": () => fakeResponse({ code: "InvalidObject", message: "timeEntry object is invalid" }, 400),
    });

    const body = await mcp("tools/call", { name: "cw_create_time_entry", arguments: baseEntry });
    const result = toolResult(body);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/POST \/time\/entries returned 400/);
    expect(result.text).toContain("timeEntry object is invalid");
    expect(result.text).not.toContain("WARNING");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /service/tickets/42",
      "PATCH /service/tickets/42",
      "POST /time/entries",
      "PATCH /service/tickets/42",
    ]);
    expect(calls[3].body).toEqual([{ op: "replace", path: "automaticEmailContactFlag", value: true }]);
  });

  it("reports both failures when the create and the restore fail", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    routedFetch({
      "GET /service/tickets/42": { automaticEmailContactFlag: true, automaticEmailResourceFlag: false, automaticEmailCcFlag: false },
      "PATCH /service/tickets/42": patchSequence(200, 403),
      "POST /time/entries": () => fakeResponse({ code: "InvalidObject", message: "timeEntry object is invalid" }, 400),
    });

    const body = await mcp("tools/call", { name: "cw_create_time_entry", arguments: baseEntry });
    const result = toolResult(body);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("timeEntry object is invalid");
    expect(result.text).toMatch(/^Time entry creation failed or could not be confirmed; check ConnectWise for the entry before retrying/);
    expect(result.text).toContain("WARNING: ticket 42 automaticEmailContactFlag left false; turn it back on with cw_update_ticket");
    expect(result.text).toContain("You do not have permission to edit tickets");
    const logged = errorLog.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes("cw_time_entry_auto_email_restore_failed"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ timeEntryCreated: false, ticketId: 42, attempts: 3 });
    expect(logged[0]).not.toHaveProperty("timeEntryId");
  });
});

describe("createTimeEntryWithEmailGuard (WYREAI-495)", () => {
  function fakeClient(ticket: Record<string, unknown>) {
    const log: string[] = [];
    const client: TimeEntryClient = {
      get: vi.fn(async (path: string, params?: Record<string, string | number | undefined>) => {
        log.push(`GET ${path} ${String(params?.fields)}`);
        return ticket;
      }) as unknown as TimeEntryClient["get"],
      patch: vi.fn(async (path: string, body: unknown) => {
        log.push(`PATCH ${path} ${JSON.stringify(body)}`);
        return {};
      }) as unknown as TimeEntryClient["patch"],
      post: vi.fn(async (path: string) => {
        log.push(`POST ${path}`);
        return { id: 1, emailContactFlag: false, emailResourceFlag: true, emailCcFlag: false };
      }) as unknown as TimeEntryClient["post"],
    };
    return { client, log };
  }

  it("toggles only flags requested false that the ticket has on", async () => {
    const { client, log } = fakeClient({
      automaticEmailContactFlag: true,
      automaticEmailResourceFlag: true,
      automaticEmailCcFlag: false,
    });
    const result = await createTimeEntryWithEmailGuard(client, { ...baseEntry, emailResourceFlag: true });
    expect(result.isError).toBeUndefined();
    expect(log).toEqual([
      `GET /service/tickets/42 ${TICKET_FIELDS}`,
      `PATCH /service/tickets/42 [{"op":"replace","path":"automaticEmailContactFlag","value":false}]`,
      "POST /time/entries",
      `PATCH /service/tickets/42 [{"op":"replace","path":"automaticEmailContactFlag","value":true}]`,
    ]);
    expect(result.content).toHaveLength(1);
  });

  it("skips the ticket read when every email flag is requested true", async () => {
    const { client, log } = fakeClient({ automaticEmailContactFlag: true });
    await createTimeEntryWithEmailGuard(client, {
      ...baseEntry,
      emailContactFlag: true,
      emailResourceFlag: true,
      emailCcFlag: true,
    });
    expect(log).toEqual(["POST /time/entries"]);
  });
});

describe("restoring the ticket flags after the create (WYREAI-495)", () => {
  const NO_WAIT = { restoreBackoffMs: [0, 0] } as const;

  /** Ticket with the contact flag on; restore PATCHes (value true) fail `restoreFailures` times. */
  function flakyRestoreClient(restoreFailures: number, opts: { postFails?: boolean; offFails?: boolean } = {}) {
    const log: string[] = [];
    let failuresLeft = restoreFailures;
    const client: TimeEntryClient = {
      connectionKey: "https://cw.example/v4_6_release/apis/3.0|acme",
      get: vi.fn(async () => ({
        automaticEmailContactFlag: true,
        automaticEmailResourceFlag: false,
        automaticEmailCcFlag: false,
      })) as unknown as TimeEntryClient["get"],
      patch: vi.fn(async (path: string, ops: { path: string; value: boolean }[]) => {
        const value = ops[0].value;
        log.push(`PATCH ${path} ${value}`);
        if (!value && opts.offFails) throw new Error("ConnectWise API PATCH /service/tickets/42 returned 500 (reference off)");
        if (value && failuresLeft > 0) {
          failuresLeft--;
          throw new Error("ConnectWise API PATCH /service/tickets/42 returned 503 (reference r1)");
        }
        return {};
      }) as unknown as TimeEntryClient["patch"],
      post: vi.fn(async () => {
        log.push("POST /time/entries");
        if (opts.postFails) throw new Error("ConnectWise API POST /time/entries returned 400 (reference p1)");
        return { id: 777, emailContactFlag: false, emailResourceFlag: false, emailCcFlag: false };
      }) as unknown as TimeEntryClient["post"],
    };
    return { client, log };
  }

  function restoreLogLines(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
    return spy.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes("cw_time_entry_auto_email_restore_failed"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("retries a failed restore and returns plain success when the second attempt works", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, log } = flakyRestoreClient(1);

    const result = await createTimeEntryWithEmailGuard(client, baseEntry, NO_WAIT);

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0].text).id).toBe(777);
    expect(log).toEqual([
      "PATCH /service/tickets/42 false",
      "POST /time/entries",
      "PATCH /service/tickets/42 true",
      "PATCH /service/tickets/42 true",
    ]);
    expect(restoreLogLines(errorLog)).toHaveLength(0);
    errorLog.mockRestore();
  });

  it("gives up after 3 restore attempts: success with the entry id, a warning, a status block and one error log", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, log } = flakyRestoreClient(99);

    const result = await createTimeEntryWithEmailGuard(client, baseEntry, NO_WAIT);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/^WARNING: time entry 777 WAS created on ticket 42\. Do not create it again\./);
    expect(result.content[0].text).toContain("automaticEmailContactFlag");
    expect(result.content[0].text).toContain("failed after 3 attempts");
    expect(JSON.parse(result.content[1].text).id).toBe(777);
    const status = JSON.parse(result.content[result.content.length - 1].text) as Record<string, unknown>;
    expect(status).toMatchObject({
      timeEntryCreated: true,
      timeEntryId: 777,
      autoEmailRestoreFailed: true,
      flagsLeftOff: ["automaticEmailContactFlag"],
      restoreAttempts: 3,
    });
    expect(log.filter((line) => line === "PATCH /service/tickets/42 true")).toHaveLength(3);
    expect(log.filter((line) => line === "POST /time/entries")).toHaveLength(1);

    const logged = restoreLogLines(errorLog);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual({
      level: "error",
      event: "cw_time_entry_auto_email_restore_failed",
      ticketId: 42,
      ticketPath: "/service/tickets/42",
      flagsLeftOff: ["automaticEmailContactFlag"],
      timeEntryCreated: true,
      timeEntryId: 777,
      attempts: 3,
      error: "ConnectWise API PATCH /service/tickets/42 returned 503 (reference r1)",
      connection: "https://cw.example/v4_6_release/apis/3.0|acme",
    });
    errorLog.mockRestore();
  });

  it("waits between restore attempts using the backoff schedule", async () => {
    vi.useFakeTimers();
    try {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const { client, log } = flakyRestoreClient(2);
      const pending = createTimeEntryWithEmailGuard(client, baseEntry, { restoreBackoffMs: [100, 300] });

      await vi.advanceTimersByTimeAsync(0);
      expect(log.filter((line) => line.endsWith("true"))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(99);
      expect(log.filter((line) => line.endsWith("true"))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(log.filter((line) => line.endsWith("true"))).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(300);
      const result = await pending;
      expect(log.filter((line) => line.endsWith("true"))).toHaveLength(3);
      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(restoreLogLines(errorLog)).toHaveLength(0);
      errorLog.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries the put-back when turning the flags off fails, and logs if it never works", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, log } = flakyRestoreClient(99, { offFails: true });

    const result = await createTimeEntryWithEmailGuard(client, baseEntry, NO_WAIT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Time entry not created/);
    expect(result.content[0].text).toContain("failed after 3 attempts");
    expect(log).not.toContain("POST /time/entries");
    expect(log.filter((line) => line === "PATCH /service/tickets/42 true")).toHaveLength(3);
    const logged = restoreLogLines(errorLog);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ timeEntryCreated: false, flagsLeftOff: ["automaticEmailContactFlag"] });
    errorLog.mockRestore();
  });

  it("returns an error saying creation failed or could not be confirmed when both the create and every restore fail", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = flakyRestoreClient(99, { postFails: true });

    const result = await createTimeEntryWithEmailGuard(client, baseEntry, NO_WAIT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Time entry creation failed or could not be confirmed; check ConnectWise for the entry before retrying to avoid a duplicate: ConnectWise API POST \/time\/entries returned 400/);
    expect(result.content[0].text).toContain("automaticEmailContactFlag left false");
    expect(restoreLogLines(errorLog)[0]).toMatchObject({ timeEntryCreated: false });
    expect(restoreLogLines(errorLog)[0]).not.toHaveProperty("timeEntryId");
    errorLog.mockRestore();
  });
});

describe("per-ticket lock around the auto-email guard (WYREAI-495)", () => {
  const FLAG_NAMES = ["automaticEmailContactFlag", "automaticEmailResourceFlag", "automaticEmailCcFlag"] as const;

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  /**
   * Fake ConnectWise holding real ticket state: PATCH mutates it, GET reads it,
   * and POST snapshots the ticket's flags at the instant the entry is created.
   */
  function statefulClient(
    tickets: Record<string, Record<string, boolean>>,
    opts: { connectionKey?: string; postGate?: (notes: string) => Promise<void>; postFail?: (notes: string) => boolean } = {},
  ) {
    const log: string[] = [];
    const flagsAtPost: Record<string, Record<string, boolean>> = {};
    const client: TimeEntryClient = {
      connectionKey: opts.connectionKey,
      get: vi.fn(async (path: string) => {
        await tick();
        log.push(`GET ${path}`);
        return { ...tickets[path] };
      }) as unknown as TimeEntryClient["get"],
      patch: vi.fn(async (path: string, ops: { path: string; value: boolean }[]) => {
        await tick();
        for (const op of ops) tickets[path][op.path] = op.value;
        log.push(`PATCH ${path} ${ops.map((o) => `${o.path}=${o.value}`).join(",")}`);
        return {};
      }) as unknown as TimeEntryClient["patch"],
      post: vi.fn(async (_path: string, body: Record<string, unknown>) => {
        const notes = String(body.notes);
        const ticketPath =
          body.chargeToType === "ProjectTicket"
            ? `/project/tickets/${String(body.chargeToId)}`
            : `/service/tickets/${String(body.chargeToId)}`;
        flagsAtPost[notes] = { ...tickets[ticketPath] };
        log.push(`POST ${notes} start`);
        if (opts.postGate) await opts.postGate(notes);
        await tick();
        log.push(`POST ${notes} end`);
        if (opts.postFail?.(notes)) throw new Error(`ConnectWise API POST /time/entries returned 500 (reference x)`);
        return { id: notes, emailContactFlag: false, emailResourceFlag: false, emailCcFlag: false };
      }) as unknown as TimeEntryClient["post"],
    };
    return { client, log, flagsAtPost };
  }

  const allOn = () => ({
    automaticEmailContactFlag: true,
    automaticEmailResourceFlag: true,
    automaticEmailCcFlag: true,
  });

  it("serializes two concurrent creates on one ticket: no flag on during a post, original flags restored", async () => {
    const tickets = { "/service/tickets/42": allOn() };
    const { client, log, flagsAtPost } = statefulClient(tickets, { connectionKey: "https://cw.example/apis|acme" });

    const [a, b] = await Promise.all([
      createTimeEntryWithEmailGuard(client, { ...baseEntry, notes: "A" }),
      createTimeEntryWithEmailGuard(client, { ...baseEntry, notes: "B" }),
    ]);

    expect(a.isError).toBeUndefined();
    expect(b.isError).toBeUndefined();
    for (const notes of ["A", "B"]) {
      for (const flag of FLAG_NAMES) expect(flagsAtPost[notes][flag]).toBe(false);
    }
    // A's whole read/toggle/post/restore finishes before B reads the ticket,
    // so B sees the original (on) flags and restores them too.
    const off = "automaticEmailContactFlag=false,automaticEmailResourceFlag=false,automaticEmailCcFlag=false";
    const on = "automaticEmailContactFlag=true,automaticEmailResourceFlag=true,automaticEmailCcFlag=true";
    expect(log).toEqual([
      "GET /service/tickets/42",
      `PATCH /service/tickets/42 ${off}`,
      "POST A start",
      "POST A end",
      `PATCH /service/tickets/42 ${on}`,
      "GET /service/tickets/42",
      `PATCH /service/tickets/42 ${off}`,
      "POST B start",
      "POST B end",
      `PATCH /service/tickets/42 ${on}`,
    ]);
    expect(tickets["/service/tickets/42"]).toEqual(allOn());
    expect(activeTicketLockCount()).toBe(0);
  });

  it("runs creates on different tickets in parallel", async () => {
    const tickets = {
      "/service/tickets/42": allOn(),
      "/service/tickets/43": allOn(),
    };
    const gateA = deferred();
    const { client, log } = statefulClient(tickets, {
      connectionKey: "k",
      postGate: (notes) => (notes === "A" ? gateA.promise : Promise.resolve()),
    });

    const a = createTimeEntryWithEmailGuard(client, { ...baseEntry, notes: "A" });
    // Ticket 43's create completes while ticket 42's POST is still held open.
    const b = await createTimeEntryWithEmailGuard(client, { ...baseEntry, chargeToId: 43, notes: "B" });
    expect(b.isError).toBeUndefined();
    expect(log).toContain("POST A start");
    expect(log).not.toContain("POST A end");
    expect(tickets["/service/tickets/43"]).toEqual(allOn());

    gateA.resolve();
    expect((await a).isError).toBeUndefined();
    expect(tickets["/service/tickets/42"]).toEqual(allOn());
    expect(activeTicketLockCount()).toBe(0);
  });

  it("does not share a lock between different connections on the same ticket id", async () => {
    const gateA = deferred();
    const ticketsA = { "/service/tickets/42": allOn() };
    const ticketsB = { "/service/tickets/42": allOn() };
    const first = statefulClient(ticketsA, { connectionKey: "tenant-a", postGate: () => gateA.promise });
    const second = statefulClient(ticketsB, { connectionKey: "tenant-b" });

    const a = createTimeEntryWithEmailGuard(first.client, { ...baseEntry, notes: "A" });
    const b = await createTimeEntryWithEmailGuard(second.client, { ...baseEntry, notes: "B" });
    expect(b.isError).toBeUndefined();
    expect(first.log).not.toContain("POST A end");

    gateA.resolve();
    await a;
    expect(activeTicketLockCount()).toBe(0);
  });

  it("releases the lock when a guarded create fails, and the next create still restores the original flags", async () => {
    const tickets = { "/service/tickets/42": allOn() };
    const { client, flagsAtPost } = statefulClient(tickets, {
      connectionKey: "k",
      postFail: (notes) => notes === "A",
    });

    const [a, b] = await Promise.all([
      createTimeEntryWithEmailGuard(client, { ...baseEntry, notes: "A" }),
      createTimeEntryWithEmailGuard(client, { ...baseEntry, notes: "B" }),
    ]);
    expect(a.isError).toBe(true);
    expect(b.isError).toBeUndefined();
    for (const flag of FLAG_NAMES) expect(flagsAtPost.B[flag]).toBe(false);
    expect(tickets["/service/tickets/42"]).toEqual(allOn());
    expect(activeTicketLockCount()).toBe(0);
  });

  it("withTicketLock: a rejection releases the lock and does not poison the chain", async () => {
    const order: string[] = [];
    const gate = deferred();
    const first = withTicketLock("k|/service/tickets/1", async () => {
      order.push("first start");
      await gate.promise;
      order.push("first throw");
      throw new Error("boom");
    });
    const second = withTicketLock("k|/service/tickets/1", async () => {
      order.push("second");
      return "ok";
    });
    await tick();
    expect(order).toEqual(["first start"]);
    expect(activeTicketLockCount()).toBe(1);

    gate.resolve();
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
    expect(order).toEqual(["first start", "first throw", "second"]);
    expect(activeTicketLockCount()).toBe(0);

    // A synchronous throw inside fn is also contained.
    await expect(
      withTicketLock("k|/service/tickets/1", () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    await expect(withTicketLock("k|/service/tickets/1", async () => 3)).resolves.toBe(3);
    expect(activeTicketLockCount()).toBe(0);
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
