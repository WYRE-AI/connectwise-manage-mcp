/**
 * Parse the request target of an inbound HTTP request.
 *
 * The target is parsed against a fixed base, never against the Host header.
 * Host is set by the client: a value such as "[" makes `new URL` throw, and an
 * uncaught throw inside a request listener ends the process. Nothing in this
 * server needs the host of an inbound request, only its path and query.
 *
 * This module is side-effect free, so tests can import it directly.
 */

const FIXED_BASE = "http://localhost";

/**
 * @param target The raw request target, `req.url`.
 * @returns The parsed URL, or null when the target is not an origin-form path
 *   ("/path?query"). Callers answer null with HTTP 400.
 */
export function parseRequestTarget(target: string | undefined): URL | null {
  const raw = target || "/";

  // Origin-form only. "//host/path" is a network-path reference that would
  // replace the fixed base, and an absolute-form target carries its own host.
  if (!raw.startsWith("/") || raw.startsWith("//")) {
    return null;
  }

  try {
    return new URL(raw, FIXED_BASE);
  } catch {
    return null;
  }
}

/**
 * Check a Host header value without letting a bad one throw.
 *
 * RFC 9112 section 3.2 has a server answer 400 to a request whose Host field
 * value is invalid. A missing Host is left to the caller: HTTP/1.0 clients
 * send none.
 *
 * @param host The raw Host header, `req.headers.host`.
 * @returns false when the value cannot be a host, with an optional port.
 */
export function isValidHostHeader(host: string | undefined): boolean {
  if (host === undefined || host === "") return true;
  // Characters that would end the authority and start a path, query,
  // fragment or userinfo are never part of a Host value.
  if (/[\s/\\?#@]/.test(host)) return false;

  try {
    return new URL(`http://${host}`).host !== "";
  } catch {
    return false;
  }
}
