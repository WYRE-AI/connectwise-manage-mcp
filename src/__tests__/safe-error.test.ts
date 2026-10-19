/**
 * Tests for upstream error handling (issue #104).
 *
 * A failed ConnectWise response reaches the caller as a status and a
 * reference id. The upstream body does not, and it is not logged. A 400 keeps
 * a short allowlist of fields so the caller can still fix the request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import worker from "../worker.js";
import { CwApiError, CwManageClient, hasApiStatus } from "../api-client.js";
import {
  MAX_DETAIL_ERRORS,
  MAX_DETAIL_STRING,
  MAX_DETAIL_TOTAL,
  formatErrorDetail,
  looksInternal,
  redactSecrets,
  safeErrorDetail,
} from "../safe-error.js";
import { handleToken, safeOAuthErrorCode } from "../auth/routes.js";
import type { EntraConfig } from "../auth/types.js";

const REFERENCE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** Text that must never reach a caller or a log. */
const SECRET_BODY_TEXT = "INTERNAL-STACK-TRACE at Server.Handler line 42 sessionToken=abc123";

function response(body: string, status: number, contentType = "application/json") {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

function client() {
  return new CwManageClient({
    baseUrl: "https://api-na.myconnectwise.net",
    companyId: "acme",
    publicKey: "PUBLIC-KEY-VALUE",
    privateKey: "PRIVATE-KEY-VALUE",
    clientId: "CLIENT-ID-VALUE",
  });
}

let errorLog: ReturnType<typeof vi.spyOn>;

/** Everything written to the error log during the test, as one string. */
function logged(): string {
  return errorLog.mock.calls.map((args: unknown[]) => args.map(String).join(" ")).join("\n");
}

beforeEach(() => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("safeErrorDetail", () => {
  it("keeps code, message and the per-field errors of a 400", () => {
    const body = JSON.stringify({
      code: "InvalidObject",
      message: "ticket object is invalid",
      errors: [
        { code: "MissingRequiredField", message: "summary is required", resource: "ticket", field: "summary" },
      ],
    });

    expect(safeErrorDetail(400, body)).toEqual({
      code: "InvalidObject",
      message: "ticket object is invalid",
      errors: [
        { code: "MissingRequiredField", message: "summary is required", resource: "ticket", field: "summary" },
      ],
    });
  });

  it("drops every field that is not on the allowlist", () => {
    const body = JSON.stringify({
      code: "InvalidObject",
      stackTrace: SECRET_BODY_TEXT,
      innerException: { detail: SECRET_BODY_TEXT },
      errors: [{ field: "summary", stackTrace: SECRET_BODY_TEXT, extra: { nested: SECRET_BODY_TEXT } }],
    });

    const detail = safeErrorDetail(400, body);

    expect(detail).toEqual({ code: "InvalidObject", errors: [{ field: "summary" }] });
    expect(JSON.stringify(detail)).not.toContain("INTERNAL-STACK-TRACE");
  });

  it.each([404, 409, 422])("keeps code, message and errors of a %i", (status) => {
    const body = JSON.stringify({
      code: "Whatever",
      message: "something is wrong",
      errors: [{ code: "c", message: "m", resource: "r", field: "f" }],
    });
    expect(safeErrorDetail(status, body)).toEqual({
      code: "Whatever",
      message: "something is wrong",
      errors: [{ code: "c", message: "m", resource: "r", field: "f" }],
    });
  });

  it.each([100, 200, 302, 500, 502, 503])("gives no detail for a %i", (status) => {
    const body = JSON.stringify({
      code: "Whatever",
      message: "validation failed",
      errors: [{ field: "summary", message: "summary is required" }],
    });
    expect(safeErrorDetail(status, body)).toBeUndefined();
  });

  it.each([500, 502, 503])("ends the CwApiError message at the reference for a %i", (status) => {
    const body = JSON.stringify({ code: "InvalidObject", errors: [{ field: "summary", message: "required" }] });
    const error = new CwApiError("POST", "/service/tickets", status, body);
    expect(error.detail).toBeUndefined();
    expect(error.message).toMatch(/\(reference [0-9a-f-]{36}\)$/);
  });

  it("uses an ASP.NET-style Message when there is no lowercase message", () => {
    expect(safeErrorDetail(400, JSON.stringify({ Message: "The request is invalid." }))).toEqual({
      message: "The request is invalid.",
    });
  });

  it("keeps code and message of a 403, so the missing permission is named", () => {
    const body = JSON.stringify({ code: "Forbidden", message: "Invoices Edit required" });
    expect(safeErrorDetail(403, body)).toEqual({
      code: "Forbidden",
      message: "Invoices Edit required",
    });
  });

  it("keeps the per-field errors of a 403 too, and nothing else", () => {
    const body = JSON.stringify({
      code: "Forbidden",
      message: "no access",
      errors: [{ code: "x", message: "y", resource: "invoice", field: "status" }],
      stackTrace: SECRET_BODY_TEXT,
      innerException: { detail: SECRET_BODY_TEXT },
    });

    const detail = safeErrorDetail(403, body);

    expect(detail).toEqual({
      code: "Forbidden",
      message: "no access",
      errors: [{ code: "x", message: "y", resource: "invoice", field: "status" }],
    });
    expect(JSON.stringify(detail)).not.toContain("INTERNAL-STACK-TRACE");
  });

  describe("internal diagnostic detail", () => {
    it.each([
      "   at Foo.Bar(String x)",
      "at Server.Handler line 42",
      "Foo.cs:line 12",
      "failed at app/file.js:10:5",
      "A Stack Trace follows",
      "INTERNAL-STACK-TRACE",
      "System.NullReferenceException",
      "InvalidOperationException: boom",
      "<html><body>oops</body></html>",
      "<!DOCTYPE html>",
      "<body>",
    ])("recognises %j", (text) => {
      expect(looksInternal(text)).toBe(true);
      expect(safeErrorDetail(400, JSON.stringify({ message: text }))).toBeUndefined();
    });

    it("leaves ordinary messages alone", () => {
      for (const text of ["summary is required", "Look at the board line items", "Exception handling is off"]) {
        expect(looksInternal(text)).toBe(false);
      }
    });

    it("drops only the offending field and keeps the rest", () => {
      const body = JSON.stringify({
        code: "InvalidObject",
        message: "at X.Y line 42",
        errors: [{ field: "summary", message: "summary is required" }, { message: "System.NullReferenceException" }],
      });
      expect(safeErrorDetail(400, body)).toEqual({
        code: "InvalidObject",
        errors: [{ field: "summary", message: "summary is required" }],
      });
    });
  });

  describe("redaction", () => {
    const BASIC = `Basic ${Buffer.from("acme+pub:priv").toString("base64")}`;
    const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlMTIz";
    const LONG = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0";

    it.each([
      ["Basic credentials", BASIC, BASIC.slice(6)],
      ["Bearer credentials", "Bearer abcDEF123456xyz", "abcDEF123456xyz"],
      ["a JWT", `token was ${JWT}`, JWT],
      ["a password pair", "password=hunter2", "hunter2"],
      ["an api key pair", "apiKey: abc123def456", "abc123def456"],
      ["an Authorization header", `Authorization: ${BASIC}`, BASIC.slice(6)],
      ["a clientId pair", "clientId=11111111-aaaa", "11111111-aaaa"],
      ["a 40-character token", `value ${LONG} end`, LONG],
    ])("redacts %s", (_label, input, secret) => {
      const detail = safeErrorDetail(400, JSON.stringify({ message: input, errors: [{ message: input }] }));
      expect(detail?.message).toContain("[redacted]");
      expect(detail?.errors?.[0].message).toContain("[redacted]");
      expect(JSON.stringify(detail)).not.toContain(secret);
      expect(redactSecrets(input)).not.toContain(secret);
    });

    it("leaves normal text alone", () => {
      const text = "communicationItems is required";
      expect(redactSecrets(text)).toBe(text);
      expect(redactSecrets("Basic information is missing")).toBe("Basic information is missing");
      expect(safeErrorDetail(400, JSON.stringify({ message: text }))?.message).toBe(text);
    });

    it("redacts before the length cap", () => {
      const detail = safeErrorDetail(400, JSON.stringify({ message: `${"x ".repeat(95)}${LONG}` }));
      expect(detail?.message).toBe(`${"x ".repeat(95)}[redacted]`);
    });

    it("redacts JSON-style pairs with a closing quote before the separator", () => {
      const key = redactSecrets('{"privateKey":"Ab12Cd34Ef56Gh78"}');
      expect(key).not.toContain("Ab12Cd34Ef56Gh78");
      expect(key).toContain("[redacted]");
      const header = redactSecrets('{"authorization": "Secret-value-123"}');
      expect(header).not.toContain("Secret-value-123");
      expect(header).toContain("[redacted]");
    });

    it("redacts a Cookie header through its semicolons", () => {
      expect(redactSecrets("Cookie: a=1; session=AbC123xyz789")).not.toContain("AbC123xyz789");
    });

    it("redacts a Set-Cookie header through its attributes", () => {
      expect(redactSecrets("Set-Cookie: sid=xyz12345; Path=/; HttpOnly")).not.toContain("xyz12345");
    });

    it("redacts a JSON-quoted cookie value containing a semicolon", () => {
      expect(redactSecrets('"cookie": "a=1; b=secret99"')).not.toContain("secret99");
    });

    it("redacts a secret key after a long run without backtracking", () => {
      const out = redactSecrets(`${"a".repeat(20000)}password=x1`);
      expect(out).not.toContain("x1");
      expect(out).toContain("[redacted]");
    });

    it("redacts a key with a suffix after the secret keyword", () => {
      const out = redactSecrets("apiKeyValue: AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf");
      expect(out).not.toContain("AbCdEfGh");
      expect(out).toContain("[redacted]");
    });

    it("leaves a non-secret pair alone", () => {
      expect(redactSecrets("field: communicationItems")).toBe("field: communicationItems");
    });

    it("keeps leading hyphens when redacting a flag-style pair", () => {
      expect(redactSecrets("--token=abc123")).toBe("--[redacted]");
    });

    it("redacts a secret pair nested in the value of a non-secret pair", () => {
      expect(redactSecrets("field=token=abc123")).not.toContain("abc123");
    });

    it("redacts a secret pair nested in a quoted value", () => {
      expect(redactSecrets('detail: "password=hunter2"')).not.toContain("hunter2");
    });

    it("redacts a double-quoted secret value that holds an escaped quote", () => {
      const out = redactSecrets('password="ab\\"cd123" next');
      expect(out).not.toContain("cd123");
      expect(out).toContain("next");
    });

    it("redacts a single-quoted secret value that holds an escaped quote", () => {
      const out = redactSecrets("password='ab\\'cd123' next");
      expect(out).not.toContain("cd123");
      expect(out).toContain("next");
    });

    it("redacts an unterminated quoted secret value to the end", () => {
      expect(redactSecrets('password="abc123 def456')).not.toContain("def456");
    });

    it("handles thousands of nested pairs without throwing", () => {
      const text = `${"a=".repeat(5000)}token=abc123`;
      let out = "";
      expect(() => {
        out = redactSecrets(text);
      }).not.toThrow();
      expect(out).not.toContain("abc123");
    });

    it("returns a long hyphen-only run unchanged", () => {
      const run = "-".repeat(20000);
      expect(redactSecrets(run)).toBe(run);
    });
  });

  it("cleans and caps the code and message of a 403 at 200 characters each", () => {
    const body = JSON.stringify({ code: "c".repeat(5000), message: "line one\r\n" + "m".repeat(5000) });

    const detail = safeErrorDetail(403, body);

    expect(detail?.code).toHaveLength(MAX_DETAIL_STRING);
    expect(detail?.message).toHaveLength(MAX_DETAIL_STRING);
    expect(detail?.message?.startsWith("line one mmm")).toBe(true);
  });

  it.each([
    ["HTML", "<html><body>" + SECRET_BODY_TEXT + "</body></html>"],
    ["plain text", SECRET_BODY_TEXT],
    ["a JSON array", JSON.stringify([{ message: SECRET_BODY_TEXT }])],
  ])("gives no detail for a 403 whose body is %s", (_label, body) => {
    expect(safeErrorDetail(403, body)).toBeUndefined();
  });

  it.each([
    ["HTML", "<html><body>" + SECRET_BODY_TEXT + "</body></html>"],
    ["plain text", SECRET_BODY_TEXT],
    ["a JSON array", JSON.stringify([{ message: SECRET_BODY_TEXT }])],
    ["a JSON string", JSON.stringify(SECRET_BODY_TEXT)],
    ["an empty body", ""],
  ])("gives no detail for a 400 whose body is %s", (_label, body) => {
    expect(safeErrorDetail(400, body)).toBeUndefined();
  });

  it("drops a field whose value is not a string", () => {
    const body = JSON.stringify({ code: { nested: SECRET_BODY_TEXT }, message: ["a", "b"] });
    expect(safeErrorDetail(400, body)).toBeUndefined();
  });

  it("cuts a long string to the size limit", () => {
    const detail = safeErrorDetail(400, JSON.stringify({ message: "x".repeat(5000) }));
    expect(detail?.message).toHaveLength(MAX_DETAIL_STRING);
    expect(detail?.message?.endsWith("...")).toBe(true);
  });

  it("keeps no more than the limit of field errors", () => {
    const errors = Array.from({ length: 50 }, (_, index) => ({ field: `field${index}` }));
    expect(safeErrorDetail(400, JSON.stringify({ errors }))?.errors).toHaveLength(MAX_DETAIL_ERRORS);
  });

  it("puts an error on one line by replacing control characters", () => {
    const detail = safeErrorDetail(400, JSON.stringify({ message: "line one\r\nline two\u0000end" }));
    expect(detail?.message).toBe("line one line two end");
  });

  it("holds the formatted detail to the total limit", () => {
    const errors = Array.from({ length: MAX_DETAIL_ERRORS }, () => ({
      code: "c".repeat(500),
      message: "m".repeat(500),
      resource: "r".repeat(500),
      field: "f".repeat(500),
    }));
    const text = formatErrorDetail(safeErrorDetail(400, JSON.stringify({ errors })));
    expect(text.length).toBeLessThanOrEqual(MAX_DETAIL_TOTAL + 3);
  });
});

describe("CwApiError", () => {
  it("carries status and a reference, and no response body", () => {
    const error = new CwApiError("GET", "/service/tickets/1", 500, SECRET_BODY_TEXT);

    expect(error.status).toBe(500);
    expect(error.reference).toMatch(REFERENCE);
    expect(error.message).toBe(
      `ConnectWise API GET /service/tickets/1 returned 500 (reference ${error.reference})`,
    );
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain("INTERNAL-STACK-TRACE");
    expect(Object.keys(error)).not.toContain("body");
  });

  it("gives each failure its own reference", () => {
    const first = new CwApiError("GET", "/x", 500, "");
    const second = new CwApiError("GET", "/x", 500, "");
    expect(first.reference).not.toBe(second.reference);
  });

  it("matches on status, not on digits in the path or the reference", () => {
    expect(hasApiStatus(new CwApiError("GET", "/service/tickets/404", 500, ""), 404, 405)).toBe(false);
    expect(hasApiStatus(new CwApiError("GET", "/service/tickets/1", 404, ""), 404, 405)).toBe(true);
    expect(hasApiStatus(new Error("returned 404"), 404)).toBe(false);
  });
});

describe("CwManageClient on a failed response", () => {
  it("gives the caller the status and a reference, and none of the upstream body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(SECRET_BODY_TEXT, 500, "text/plain")));

    const error = await client().get("/service/tickets/1").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CwApiError);
    expect((error as CwApiError).message).toMatch(/returned 500 \(reference [0-9a-f-]{36}\)$/);
    expect((error as CwApiError).message).not.toContain("INTERNAL-STACK-TRACE");
  });

  it("logs method, path, status and the same reference, and nothing else", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(SECRET_BODY_TEXT, 500, "text/plain")));

    const error = (await client()
      .get("/service/tickets/1", { conditions: "summary = 'private text'" })
      .catch((err: unknown) => err)) as CwApiError;

    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorLog.mock.calls[0][0]))).toEqual({
      event: "connectwise_request_failed",
      method: "GET",
      path: "/service/tickets/1",
      status: 500,
      reference: error.reference,
    });
  });

  it("never logs the body, the query, a key or the authorisation header", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(SECRET_BODY_TEXT, 500, "text/plain")));

    await client()
      .get("/service/tickets/1", { conditions: "summary = 'private text'" })
      .catch(() => undefined);

    const output = logged();
    expect(output).not.toContain("INTERNAL-STACK-TRACE");
    expect(output).not.toContain("sessionToken");
    expect(output).not.toContain("private text");
    expect(output).not.toContain("PUBLIC-KEY-VALUE");
    expect(output).not.toContain("PRIVATE-KEY-VALUE");
    expect(output).not.toContain("CLIENT-ID-VALUE");
    expect(output).not.toContain("Basic ");
    expect(output).not.toContain(Buffer.from("acme+PUBLIC-KEY-VALUE:PRIVATE-KEY-VALUE").toString("base64"));
  });

  it("keeps a 400 actionable: the refused field is named in the message", async () => {
    const body = JSON.stringify({
      code: "InvalidObject",
      message: "ticket object is invalid",
      errors: [{ code: "MissingRequiredField", message: "summary is required", field: "summary" }],
      stackTrace: SECRET_BODY_TEXT,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body, 400)));

    const error = (await client().post("/service/tickets", {}).catch((err: unknown) => err)) as CwApiError;

    expect(error.message).toMatch(/returned 400 \(reference [0-9a-f-]{36}\): \{/);
    expect(error.message).toContain("summary is required");
    expect(error.message).toContain('"field":"summary"');
    expect(error.message).not.toContain("INTERNAL-STACK-TRACE");
    expect(logged()).not.toContain("summary is required");
  });

  it("names the refused field on a PATCH of a contact, and keeps it out of the log", async () => {
    const body = JSON.stringify({
      code: "InvalidObject",
      errors: [{ code: "InvalidValue", message: "title is too long", field: "title" }],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body, 400)));

    const error = (await client()
      .patch("/company/contacts/42", [{ op: "replace", path: "title", value: "x" }])
      .catch((err: unknown) => err)) as CwApiError;

    expect(error.message).toContain('"field":"title"');
    expect(error.message).toContain("title is too long");
    expect(logged()).not.toContain("title is too long");
    expect(logged()).not.toContain("InvalidValue");
  });

  it("names the missing permission on a 403, and keeps the rest of the body out", async () => {
    const body = JSON.stringify({
      code: "Forbidden",
      message: "Invoices Edit required",
      stackTrace: SECRET_BODY_TEXT,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body, 403)));

    const error = (await client().get("/finance/invoices/1").catch((err: unknown) => err)) as CwApiError;

    expect(error.status).toBe(403);
    expect(error.message).toMatch(
      /returned 403 \(reference [0-9a-f-]{36}\): \{"code":"Forbidden","message":"Invoices Edit required"\}$/,
    );
    expect(error.message).not.toContain("INTERNAL-STACK-TRACE");
    expect(logged()).not.toContain("Invoices Edit required");
  });

  it("still fails cleanly when the error body cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.reject(new Error("stream broke")),
      } as unknown as Response),
    );

    const error = (await client().get("/system/info").catch((err: unknown) => err)) as CwApiError;

    expect(error).toBeInstanceOf(CwApiError);
    expect(error.status).toBe(502);
  });
});

describe("an MCP tool call on a failed response", () => {
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "X-CW-Company-Id": "acme",
    "X-CW-Public-Key": "pub",
    "X-CW-Private-Key": "priv",
    "X-CW-Client-Id": "client-guid",
  };

  async function call(name: string, args: unknown) {
    const res = await worker.fetch(
      new Request("http://worker.local/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
      { AUTH_MODE: "gateway" },
    );
    const raw = await res.text();
    return { raw, result: (JSON.parse(raw) as { result: { content: { text: string }[]; isError?: boolean } }).result };
  }

  it("returns status and reference from a single tool, with no upstream body anywhere in the reply", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(SECRET_BODY_TEXT, 500, "text/html")));

    const { raw, result } = await call("cw_search_tickets", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/returned 500 \(reference [0-9a-f-]{36}\)/);
    expect(raw).not.toContain("INTERNAL-STACK-TRACE");
    expect(raw).not.toContain("sessionToken");
  });

  it("returns status and reference per row from a batch tool, with no upstream body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(JSON.stringify({ message: SECRET_BODY_TEXT }), 409)),
    );

    const { raw, result } = await call("cw_update_ticket_configurations", {
      id: 77,
      operations: [{ action: "add", configurationId: 123 }],
    });

    const payload = JSON.parse(result.content[0].text) as { results: { error: string }[] };
    expect(payload.results[0].error).toMatch(/returned 409 \(reference [0-9a-f-]{36}\)$/);
    expect(raw).not.toContain("INTERNAL-STACK-TRACE");
  });

  it("falls back from allNotes to notes on a 404, by status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify({ message: "no such route" }), 404))
      .mockResolvedValueOnce(response(JSON.stringify([{ id: 1, text: "note" }]), 200));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = await call("cw_get_ticket_notes", { id: 77 });

    expect(result.isError).not.toBe(true);
    expect(new URL(fetchMock.mock.calls[1][0]).pathname).toMatch(/\/service\/tickets\/77\/notes$/);
  });

  it("does not fall back when the ticket id only looks like a 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("{}", 500));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = await call("cw_get_ticket_notes", { id: 404 });

    expect(result.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("token exchange logging", () => {
  const config = { tenantId: "tenant-guid", clientId: "client-guid" } as EntraConfig;
  const AZURE_BODY_SECRET = "AADSTS70008 trace 11111111-2222 refresh_token=SECRET-REFRESH-TOKEN";

  function tokenRequest(): IncomingMessage {
    const req = new EventEmitter() as unknown as IncomingMessage;
    queueMicrotask(() => {
      (req as unknown as EventEmitter).emit("data", Buffer.from("grant_type=authorization_code&code=SECRET-AUTH-CODE"));
      (req as unknown as EventEmitter).emit("end");
    });
    return req;
  }

  function tokenResponse() {
    const captured: { status?: number; body?: string } = {};
    const res = {
      writeHead(status: number) {
        captured.status = status;
        return res;
      },
      end(body?: string) {
        captured.body = body;
      },
    } as unknown as ServerResponse;
    return { res, captured };
  }

  it("logs the status and the OAuth error code when Azure rejects the exchange", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(JSON.stringify({ error: "invalid_grant", error_description: AZURE_BODY_SECRET }), 400),
      ),
    );
    const { res, captured } = tokenResponse();

    await handleToken(tokenRequest(), res, config);

    expect(captured.status).toBe(400);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorLog.mock.calls[0][0]))).toEqual({
      event: "token_exchange_rejected",
      status: 400,
      error: "invalid_grant",
    });
  });

  it("never logs the Azure body, the description, a token or the authorisation code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(JSON.stringify({ error: "invalid_grant", error_description: AZURE_BODY_SECRET }), 400),
      ),
    );

    await handleToken(tokenRequest(), tokenResponse().res, config);

    const output = logged();
    expect(output).not.toContain("AADSTS70008");
    expect(output).not.toContain("SECRET-REFRESH-TOKEN");
    expect(output).not.toContain("SECRET-AUTH-CODE");
  });

  it("logs no body when Azure answers with something that is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(AZURE_BODY_SECRET, 500, "text/html")));

    await handleToken(tokenRequest(), tokenResponse().res, config);

    expect(logged()).not.toContain("SECRET-REFRESH-TOKEN");
    expect(JSON.parse(String(errorLog.mock.calls[0][0]))).toMatchObject({ status: 500, error: "invalid_request" });
  });

  it("logs only the error name when Azure cannot be reached", async () => {
    const failure = new TypeError("fetch failed");
    (failure as { cause?: unknown }).cause = { secret: "SECRET-IN-CAUSE" };
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
    const { res, captured } = tokenResponse();

    await handleToken(tokenRequest(), res, config);

    expect(captured.status).toBe(502);
    expect(JSON.parse(String(errorLog.mock.calls[0][0]))).toEqual({
      event: "token_proxy_error",
      error: "TypeError",
    });
    expect(logged()).not.toContain("SECRET-IN-CAUSE");
  });

  it.each([
    ["a normal code", "invalid_grant", "invalid_grant"],
    ["free text", "AADSTS70008: the token expired", "unrecognised_error"],
    ["a very long value", "a".repeat(200), "unrecognised_error"],
    ["a value that is not a string", { nested: true }, "unrecognised_error"],
  ])("reduces %s to a safe error code", (_label, value, expected) => {
    expect(safeOAuthErrorCode(value)).toBe(expected);
  });
});
