/**
 * Safe handling of a failed ConnectWise response (issue #104).
 *
 * An upstream error body can hold stack traces, HTML, request metadata or
 * other internal detail. None of it goes to an MCP caller or into a log. A
 * caller gets the HTTP status and a reference id. The log line carries the
 * same reference, so an operator can match the two.
 *
 * One exception keeps an error usable. A 4xx keeps a short allowlist of
 * fields from a JSON body (`code`, `message` and the per-field `errors`), so
 * the caller can see which field or permission ConnectWise refused. Every
 * copied string is redacted of secrets, cleaned and size-limited. A 5xx and
 * every other status keep only the status and the reference.
 *
 * This module has no imports and is side-effect free.
 */

/** Longest single string copied out of an error body, ellipsis included. */
export const MAX_DETAIL_STRING = 200;
/** Most entries copied out of the `errors` array of a 4xx body. */
export const MAX_DETAIL_ERRORS = 5;
/** Longest detail text added to an error message. */
export const MAX_DETAIL_TOTAL = 1000;

/** The fields of one ConnectWise validation error that are safe to show. */
export interface SafeFieldError {
  code?: string;
  message?: string;
  resource?: string;
  field?: string;
}

/** The fields of a ConnectWise error body that are safe to show. */
export interface SafeErrorDetail {
  code?: string;
  message?: string;
  errors?: SafeFieldError[];
}

/** A new reference id that ties a caller's error to its log line. */
export function newErrorReference(): string {
  return globalThis.crypto.randomUUID();
}

const REDACTED = "[redacted]";

const SECRET_KEYS =
  "password|passwd|secret|token|api[_-]?key|private[_-]?key|public[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|sessionid";

const SECRET_PAIR = new RegExp(
  `\\b[\\w-]*(?:${SECRET_KEYS})\\s*[:=]\\s*(?:"[^"]*"|'[^']*'|[^\\s,;&]+)`,
  "gi",
);

/** Replace credentials and key-like values in `text` with "[redacted]". */
export function redactSecrets(text: string): string {
  return (
    text
      // Header-style values: "Authorization: ...", "clientId=...".
      .replace(/\b(?:authorization|client-?id|x-api-key|set-cookie|cookie)\s*[:=][^\r\n,;]*/gi, REDACTED)
      // Basic and Bearer credentials. A Basic value must look like base64, not a word.
      .replace(/\bBearer\s+[A-Za-z0-9+/=._~-]{8,}/gi, REDACTED)
      .replace(/\b[Bb][Aa][Ss][Ii][Cc]\s+(?=[A-Za-z0-9+/=]*(?:\d|[+/=]|[a-z][A-Z]))[A-Za-z0-9+/=]{8,}/g, REDACTED)
      // JWTs.
      .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]+/g, REDACTED)
      // key=value and key: value pairs with a secret-looking key.
      .replace(SECRET_PAIR, REDACTED)
      // Long opaque runs that hold a digit: keys and tokens, not words.
      .replace(/[A-Za-z0-9+/=_-]{32,}/g, (run) => (/\d/.test(run) ? REDACTED : run))
  );
}

const INTERNAL_DETAIL = [
  /^\s*at\s+[\w$.<>`[\]]+\s*\(/m, // "   at Foo.Bar("
  /\bat\s+[\w$.<>`]+\s+line\s+\d+/i, // "at X.Y line 42"
  /\.cs:line\s+\d+/i, // ".cs:line 12"
  /\bat\s+\S+:\d+:\d+/, // "at file.js:10:5"
  /stack[\s_-]?trace/i,
  /\b(?:System|Microsoft)\.[\w.]*Exception\b|\b\w+Exception:/, // .NET exception types
  /<\s*(?:html|!doctype|body)\b/i,
];

/** True when `text` looks like internal diagnostic detail: a stack trace, an exception type or HTML. */
export function looksInternal(text: string): boolean {
  return INTERNAL_DETAIL.some((pattern) => pattern.test(text));
}

/** A short plain string, or undefined. Anything that is not a string, or looks internal, is dropped. */
function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (looksInternal(value)) return undefined;
  const cleaned = redactSecrets(value)
    // Control characters, including newlines: one error stays on one line.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  if (cleaned === "") return undefined;
  return cleaned.length > MAX_DETAIL_STRING
    ? `${cleaned.slice(0, MAX_DETAIL_STRING - 3)}...`
    : cleaned;
}

/** Copy the named string fields of `source`, and nothing else. */
function pick<K extends string>(source: unknown, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  if (typeof source !== "object" || source === null) return out;
  for (const key of keys) {
    const value = safeString((source as Record<string, unknown>)[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The safe detail of a failed response, or undefined when there is none.
 *
 * Only a 4xx with a JSON object body yields detail: `code`, `message` (or an
 * ASP.NET-style `Message`) and the per-field `errors`. Every other status,
 * and any body that is not a JSON object (HTML, plain text, an array),
 * yields nothing.
 */
export function safeErrorDetail(status: number, body: string): SafeErrorDetail | undefined {
  if (status < 400 || status > 499) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const detail: SafeErrorDetail = pick(parsed, ["code", "message"] as const);

  if (detail.message === undefined) {
    const message = safeString((parsed as { Message?: unknown }).Message);
    if (message !== undefined) detail.message = message;
  }

  const rawErrors = (parsed as { errors?: unknown }).errors;
  if (Array.isArray(rawErrors)) {
    const errors = rawErrors
      .slice(0, MAX_DETAIL_ERRORS)
      .map((entry) => pick(entry, ["code", "message", "resource", "field"] as const))
      .filter((entry) => Object.keys(entry).length > 0);
    if (errors.length > 0) detail.errors = errors;
  }

  return Object.keys(detail).length > 0 ? detail : undefined;
}

/** The detail as one line of text for an error message, within the total limit. */
export function formatErrorDetail(detail: SafeErrorDetail | undefined): string {
  if (!detail) return "";
  const text = JSON.stringify(detail);
  return text.length > MAX_DETAIL_TOTAL ? `${text.slice(0, MAX_DETAIL_TOTAL)}...` : text;
}

/**
 * Write the one log line for a failed ConnectWise request: method, path,
 * status and reference. Never the response body, a header, a key or a token.
 * The path is the API path the tool asked for, without its query string.
 */
export function logRequestFailure(entry: {
  method: string;
  path: string;
  status: number;
  reference: string;
}): void {
  console.error(
    JSON.stringify({
      event: "connectwise_request_failed",
      method: entry.method,
      path: entry.path,
      status: entry.status,
      reference: entry.reference,
    }),
  );
}
