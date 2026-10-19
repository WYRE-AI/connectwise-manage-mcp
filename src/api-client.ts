/**
 * ConnectWise Manage API Client
 *
 * Fetch-based HTTP client that handles authentication, pagination,
 * and self-signed certificate support for both cloud and self-hosted instances.
 *
 * Environment variables:
 *   CW_MANAGE_URL              - API base URL (e.g. https://api-na.myconnectwise.net)
 *   CW_MANAGE_COMPANY_ID       - Company identifier
 *   CW_MANAGE_PUBLIC_KEY        - API member public key
 *   CW_MANAGE_PRIVATE_KEY       - API member private key
 *   CW_MANAGE_CLIENT_ID         - Client ID from ConnectWise Developer Portal
 *   CW_MANAGE_REJECT_UNAUTHORIZED - Set to "false" to allow self-signed certs (default: "true")
 *
 * Self-signed certificate support is scoped to this client instance's own
 * requests via an undici Agent passed as fetch's `dispatcher` option -- NOT
 * via the process-global NODE_TLS_REJECT_UNAUTHORIZED env var, which would
 * affect every concurrent request in the process (including unrelated
 * tenants' cloud-hosted, fully-verified connections).
 */
import { Agent } from "undici";
import {
  formatErrorDetail,
  logRequestFailure,
  newErrorReference,
  safeErrorDetail,
  type SafeErrorDetail,
} from "./safe-error.js";
import { assertSafeGatewayUrl } from "./url-guard.js";

export interface CwManageConfig {
  baseUrl: string;
  companyId: string;
  publicKey: string;
  privateKey: string;
  clientId: string;
  /** Set when baseUrl came from the X-CW-Url header; checked before every request. */
  untrustedBaseUrl?: boolean;
}

export function getConfig(): CwManageConfig | null {
  const companyId = process.env.CW_MANAGE_COMPANY_ID;
  const publicKey = process.env.CW_MANAGE_PUBLIC_KEY;
  const privateKey = process.env.CW_MANAGE_PRIVATE_KEY;
  const clientId = process.env.CW_MANAGE_CLIENT_ID;

  if (!companyId || !publicKey || !privateKey || !clientId) {
    return null;
  }

  // Default to North America cloud. Override for EU, AU, or self-hosted.
  const baseUrl = (
    process.env.CW_MANAGE_URL || "https://api-na.myconnectwise.net"
  ).replace(/\/+$/, "");

  return { baseUrl, companyId, publicKey, privateKey, clientId };
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Error thrown for a non-2xx Manage response.
 *
 * The message is "ConnectWise API {METHOD} {path} returned {status}
 * (reference {id})". It never holds the upstream response body, and neither
 * does this object: the body is read once in the constructor to pull the
 * allowlisted detail out of a 400 or a 403, then dropped. A 400 message ends
 * with that detail so the caller can see which field was refused, and a 403
 * message with ConnectWise's code and message so the caller can see which
 * permission is missing.
 *
 * `status` lets callers branch on the HTTP code (e.g. retry policy) without
 * parsing the message. `reference` matches the log line written for the
 * failure. The client itself never retries.
 */
export class CwApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly reference: string;
  readonly detail: SafeErrorDetail | undefined;

  constructor(method: string, path: string, status: number, body: string) {
    const reference = newErrorReference();
    const detail = safeErrorDetail(status, body);
    const suffix = detail ? `: ${formatErrorDetail(detail)}` : "";
    super(`ConnectWise API ${method} ${path} returned ${status} (reference ${reference})${suffix}`);
    this.name = "CwApiError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.reference = reference;
    this.detail = detail;
  }
}

/**
 * True when `err` is a ConnectWise response with one of the given statuses.
 * Use this, not a search of the message text: a message also holds a path and
 * a reference id, and either can contain the same digits as a status.
 */
export function hasApiStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof CwApiError && statuses.includes(err.status);
}

/**
 * Low-level API client for ConnectWise Manage REST API.
 */
export class CwManageClient {
  private readonly authHeader: string;
  private readonly clientId: string;
  private readonly apiBase: string;
  private readonly dispatcher: Agent | undefined;
  private readonly untrustedBaseUrl: string | undefined;

  constructor(config: CwManageConfig) {
    // Auth: Basic base64("{companyId}+{publicKey}:{privateKey}")
    const credentials = `${config.companyId}+${config.publicKey}:${config.privateKey}`;
    this.authHeader = `Basic ${Buffer.from(credentials).toString("base64")}`;
    this.clientId = config.clientId;
    this.untrustedBaseUrl = config.untrustedBaseUrl ? config.baseUrl : undefined;
    // Append the standard API path if the URL doesn't already contain it
    this.apiBase = config.baseUrl.includes("/v4_6_release/")
      ? config.baseUrl.replace(/\/+$/, "")
      : `${config.baseUrl}/v4_6_release/apis/3.0`;
    // Only build a custom dispatcher when relaxed TLS is explicitly requested.
    // Scoped to this client instance's own connections only -- never touches
    // process.env, so a self-hosted (self-signed) instance's relaxed TLS
    // verification can never bleed into a concurrent request against a
    // different (cloud, fully-verified) tenant's connection.
    //
    // The default (verified) path deliberately uses Node's built-in fetch
    // dispatcher: passing the standalone `undici` package's Agent to Node's
    // global fetch breaks every request when the bundled undici version is
    // incompatible with the one embedded in the running Node runtime.
    this.dispatcher =
      process.env.CW_MANAGE_REJECT_UNAUTHORIZED === "false"
        ? new Agent({ connect: { rejectUnauthorized: false } })
        : undefined;
  }

  private defaultHeaders(): Record<string, string> {
    return {
      Authorization: this.authHeader,
      clientId: this.clientId,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  /**
   * Make a request to the ConnectWise Manage API.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      params?: Record<string, string | number | undefined>;
    },
  ): Promise<T> {
    // Re-checked per request so a hostname re-pointed after the last call is caught.
    // Known gap (documented, not closed): DNS can change between this lookup and
    // the connection. Closing it needs a runtime lookup/dispatcher that pins the
    // resolved address on the socket. This repo intentionally does not pass a
    // standalone undici Agent to global fetch on the default path — mismatched
    // undici versions have broken every request before. With redirects refused
    // for gateway URLs, the window is small.
    if (this.untrustedBaseUrl !== undefined) {
      await assertSafeGatewayUrl(this.untrustedBaseUrl);
    }
    const url = new URL(`${this.apiBase}${path}`);

    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    // Redirect blocking is gateway-only: env-mode CW_MANAGE_URL may legitimately
    // 301/302 to a canonical HTTPS origin on a self-hosted server. Cloudflare
    // Workers reject redirect: "error", so gateway mode uses "manual" + a throw.
    const blockRedirects = this.untrustedBaseUrl !== undefined;
    const fetchOptions: RequestInit = {
      method,
      headers: this.defaultHeaders(),
      redirect: blockRedirects ? "manual" : "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };

    // Self-hosted instances with self-signed certificates: the dispatcher
    // built in the constructor (only when CW_MANAGE_REJECT_UNAUTHORIZED is
    // "false") scopes rejectUnauthorized to THIS client's connections only,
    // with no process-global state involved.
    //
    // Assigned via a cast rather than a typed `dispatcher` field on
    // fetchOptions: Node's global fetch/RequestInit types (from the
    // `undici-types` package bundled with @types/node) declare their own
    // `Dispatcher` interface, structurally incompatible with the standalone
    // `undici` package's `Dispatcher` -- a well-known dual-package hazard.
    // The value is fully compatible at runtime (Node's fetch is undici under
    // the hood); only the type-checker sees two different declarations.
    if (this.dispatcher) {
      (fetchOptions as { dispatcher?: unknown }).dispatcher = this.dispatcher;
    }

    if (options?.body !== undefined) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url.toString(), fetchOptions);

    if (
      blockRedirects &&
      response.status >= 300 &&
      response.status < 400
    ) {
      throw new Error(
        `ConnectWise API ${method} ${path} returned a redirect (HTTP ${response.status}); refusing to follow it.`,
      );
    }

    if (!response.ok) {
      // The body is read only so a 400 or a 403 can keep its allowlisted detail. It is
      // never logged and never reaches the caller.
      const errorBody = await response.text().catch(() => "");
      const error = new CwApiError(method, path, response.status, errorBody);
      logRequestFailure({
        method,
        path,
        status: error.status,
        reference: error.reference,
      });
      throw error;
    }

    // Some endpoints return 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  /** GET helper */
  async get<T = unknown>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
    return this.request<T>("GET", path, { params });
  }

  /** POST helper */
  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  /** PATCH helper */
  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }

  /** DELETE helper. Manage returns 204 No Content on success. */
  async delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}
