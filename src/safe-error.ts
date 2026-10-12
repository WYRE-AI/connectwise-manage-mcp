/**
 * Safe handling of a failed ConnectWise response (issue #104).
 *
 * An upstream error body can hold stack traces, HTML, request metadata or
 * other internal detail. None of it goes to an MCP caller or into a log. A
 * caller gets the HTTP status and a reference id. The log line carries the
 * same reference, so an operator can match the two.
 *
 * Two exceptions keep an error usable. Each copies a short allowlist of
 * fields out of a JSON body, every string cleaned and size-limited:
 *
 * - 400: `code`, `message` and the per-field `errors`, so the caller can see
 *   which field ConnectWise refused.
 * - 403: `code` and `message` only, so the caller can see which permission
 *   is missing.
 *
 * This module has no imports and is side-effect free.
 */

/** Longest single string copied out of an error body, ellipsis included. */
export const MAX_DETAIL_STRING = 200;
/** Most entries copied out of the `errors` array of a 400 body. */
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

/** A short plain string, or undefined. Anything that is not a string is dropped. */
function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
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
 * Only a 400 or a 403 with a JSON object body yields detail. A 403 yields
 * `code` and `message` and never `errors`. Every other status, and any body
 * that is not a JSON object (HTML, plain text, an array), yields nothing.
 */
export function safeErrorDetail(status: number, body: string): SafeErrorDetail | undefined {
  if (status !== 400 && status !== 403) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const detail: SafeErrorDetail = pick(parsed, ["code", "message"] as const);

  const rawErrors = status === 400 ? (parsed as { errors?: unknown }).errors : undefined;
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
