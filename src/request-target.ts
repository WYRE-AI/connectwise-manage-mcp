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
const FIXED_HOST = new URL(FIXED_BASE).host;

/**
 * @param target The raw request target, `req.url`.
 * @returns The parsed URL, or null when the target is not an origin-form path
 *   ("/path?query"). Callers answer null with HTTP 400.
 */
export function parseRequestTarget(target: string | undefined): URL | null {
  const raw = target || "/";

  // Origin-form only. "//host/path" is a network-path reference that would
  // replace the fixed base, and an absolute-form target carries its own host.
  // WHATWG URL parsing reads a backslash as a slash in an http URL, so "/\host"
  // is the same network-path reference.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(raw, FIXED_BASE);
  } catch {
    return null;
  }
  // WHATWG URL parsing also drops tab and newline before it reads the target,
  // so "/\t/host" becomes "//host". Whatever the prefix, a target that moves
  // the host off the fixed base is not origin-form.
  return url.host === FIXED_HOST ? url : null;
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
