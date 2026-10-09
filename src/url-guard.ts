/**
 * Guards a ConnectWise base URL that arrived in the X-CW-Url gateway header.
 *
 * The header is caller-controlled, so without this the server would fetch any
 * URL it is handed: loopback, private networks, cloud metadata endpoints.
 * Env-mode URLs (CW_MANAGE_URL) are set by the operator and skip this check,
 * since a self-hoster may legitimately point at a server on their own LAN.
 */
import { lookup } from "node:dns/promises";

export class UnsafeUrlError extends Error {}

/** Throws UnsafeUrlError unless `input` is https and every address it resolves to is public. */
export async function assertSafeGatewayUrl(input: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeUrlError("ConnectWise URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new UnsafeUrlError("ConnectWise URL must use https.");
  }
  // A fragment or query would swallow the API path appended after the base.
  if (url.username || url.password || url.search || url.hash || input.includes("#") || input.includes("?")) {
    throw new UnsafeUrlError("ConnectWise URL must not contain credentials, a query string, or a fragment.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addrs: { address: string }[];
  try {
    addrs = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError("ConnectWise URL hostname did not resolve.");
  }
  if (addrs.length === 0 || addrs.some((a) => !isPublicIp(a.address))) {
    throw new UnsafeUrlError("ConnectWise URL points to a non-public address.");
  }
}

export function isPublicIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return isPublicIpv4(v4);
  return isPublicIpv6(ip.toLowerCase());
}

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

function isPublicIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false; // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast and reserved
  return true;
}

function isPublicIpv6(ip: string): boolean {
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry a v4 address.
  const embedded = ip.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) {
    const v4 = parseIpv4(embedded[1]);
    return v4 ? isPublicIpv4(v4) : false;
  }
  if (/^::ffff:/.test(ip) || /^64:ff9b:/.test(ip)) return false; // hex-form mapped: reject
  if (ip === "::" || ip === "::1") return false;
  const first = parseInt(ip.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // multicast ff00::/8
  return true;
}
