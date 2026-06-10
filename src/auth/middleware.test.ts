import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash, timingSafeEqual } from "node:crypto";
import { AuthError, type EntraConfig } from "./types.js";
import { validateToken } from "./middleware.js";

// ---------------------------------------------------------------------------
// Mock jose so tests don't hit real Azure AD
// ---------------------------------------------------------------------------

vi.mock("jose", async () => {
  const actual = await vi.importActual<typeof import("jose")>("jose");
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(() => vi.fn()),
    jwtVerify: vi.fn(),
  };
});

import { jwtVerify } from "jose";

// ---------------------------------------------------------------------------
// Shared test config
// ---------------------------------------------------------------------------

const config: EntraConfig = {
  tenantId: "test-tenant-id",
  clientId: "test-client-id",
  audience: "api://test-client-id",
  extraAudiences: [],
  requiredRole: "CWM.Access",
  serverUrl: "https://mcp.example.com",
};

const mockJwks = vi.fn() as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>;

// ---------------------------------------------------------------------------
// validateToken
// ---------------------------------------------------------------------------

describe("validateToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns EntraIdentity for a valid token with correct role", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: {
        tid: "test-tenant-id",
        roles: ["CWM.Access"],
        upn: "user@example.com",
        name: "Test User",
        oid: "test-oid",
        aud: "api://test-client-id",
        iss: `https://login.microsoftonline.com/test-tenant-id/v2.0`,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        nbf: Math.floor(Date.now() / 1000),
        sub: "test-sub",
      },
      protectedHeader: { alg: "RS256" },
      key: {} as any,
    } as any);

    const identity = await validateToken("valid-token", config, mockJwks);

    expect(identity.upn).toBe("user@example.com");
    expect(identity.name).toBe("Test User");
    expect(identity.roles).toContain("CWM.Access");
    expect(identity.oid).toBe("test-oid");
  });

  it("throws AuthError(401) when tenant id does not match", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: {
        tid: "wrong-tenant-id",
        roles: ["CWM.Access"],
        upn: "user@example.com",
        oid: "test-oid",
        aud: "api://test-client-id",
        iss: `https://login.microsoftonline.com/test-tenant-id/v2.0`,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        nbf: Math.floor(Date.now() / 1000),
        sub: "test-sub",
      },
      protectedHeader: { alg: "RS256" },
      key: {} as any,
    } as any);

    await expect(validateToken("valid-token", config, mockJwks)).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringContaining("tenant"),
    });
  });

  it("throws AuthError(403) when required role is missing", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: {
        tid: "test-tenant-id",
        roles: ["SomeOtherRole"],
        upn: "user@example.com",
        oid: "test-oid",
        aud: "api://test-client-id",
        iss: `https://login.microsoftonline.com/test-tenant-id/v2.0`,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        nbf: Math.floor(Date.now() / 1000),
        sub: "test-sub",
      },
      protectedHeader: { alg: "RS256" },
      key: {} as any,
    } as any);

    const error = await validateToken("valid-token", config, mockJwks).catch((e) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).statusCode).toBe(403);
    expect(error.message).toContain("CWM.Access");
  });

  it("throws AuthError(401) when all audiences fail validation", async () => {
    vi.mocked(jwtVerify).mockRejectedValue(new Error("JWTClaimValidationFailed"));

    const error = await validateToken("bad-token", config, mockJwks).catch((e) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).statusCode).toBe(401);
  });

  it("propagates AuthError immediately without retrying other audiences", async () => {
    const authErr = new AuthError("Access denied: missing required role 'CWM.Access'", 403);
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: {
        tid: "test-tenant-id",
        roles: [],
        oid: "oid",
        aud: "api://test-client-id",
        iss: `https://login.microsoftonline.com/test-tenant-id/v2.0`,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        nbf: Math.floor(Date.now() / 1000),
        sub: "sub",
      },
      protectedHeader: { alg: "RS256" },
      key: {} as any,
    } as any);

    const error = await validateToken("bad-role-token", config, mockJwks).catch((e) => e);
    expect(error).toBeInstanceOf(AuthError);
    // jwtVerify should only be called once — AuthError is not retried
    expect(vi.mocked(jwtVerify)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Static bearer token comparison (timing-safe, SHA-256)
// ---------------------------------------------------------------------------

describe("static bearer token comparison", () => {
  function compareTokens(incoming: string, stored: string): boolean {
    return timingSafeEqual(
      createHash("sha256").update(incoming).digest(),
      createHash("sha256").update(stored).digest(),
    );
  }

  it("returns true for matching tokens", () => {
    expect(compareTokens("secret-token", "secret-token")).toBe(true);
  });

  it("returns false for wrong token", () => {
    expect(compareTokens("wrong-token", "secret-token")).toBe(false);
  });

  it("returns false for same-length wrong token (no length oracle)", () => {
    const stored = "abcdefghij";
    const wrong = "xxxxxxxxxx"; // same length, different content
    expect(compareTokens(wrong, stored)).toBe(false);
  });

  it("returns false for shorter token without throwing", () => {
    // SHA-256 hashes are always 32 bytes regardless of input length,
    // so timingSafeEqual never throws a length mismatch error
    expect(compareTokens("short", "much-longer-secret-token")).toBe(false);
  });

  it("returns false for empty string vs stored token", () => {
    expect(compareTokens("", "secret-token")).toBe(false);
  });
});
