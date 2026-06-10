import { createRemoteJWKSet, jwtVerify, type JWTPayload, type RemoteJWKSetOptions } from "jose";
import { AuthError, type EntraConfig, type EntraIdentity } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function getEntraConfig(): EntraConfig {
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const audience = process.env.AZURE_AUDIENCE;
  const serverUrl = process.env.MCP_SERVER_URL;

  if (!tenantId || !clientId || !audience || !serverUrl) {
    throw new Error(
      "Missing required Entra ID environment variables: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_AUDIENCE, MCP_SERVER_URL",
    );
  }

  const extraAudiences = (process.env.AZURE_EXTRA_AUDIENCES ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  return {
    tenantId,
    clientId,
    audience,
    extraAudiences,
    requiredRole: process.env.AZURE_REQUIRED_ROLE ?? "CWM.Access",
    serverUrl: serverUrl.replace(/\/$/, ""),
    bearerToken: process.env.MCP_BEARER_TOKEN || undefined,
  };
}

// ---------------------------------------------------------------------------
// JWKS client (cached per-process by jose)
// ---------------------------------------------------------------------------

type JwksClient = ReturnType<typeof createRemoteJWKSet>;

export function createJwksClient(config: EntraConfig): JwksClient {
  const jwksUrl = new URL(
    `https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`,
  );
  const options: RemoteJWKSetOptions = {
    cacheMaxAge: 60 * 60 * 1000, // 1 hour
  };
  return createRemoteJWKSet(jwksUrl, options);
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

interface EntraJwtPayload extends JWTPayload {
  upn?: string;
  unique_name?: string;
  preferred_username?: string;
  name?: string;
  roles?: string[];
  tid?: string;
  oid?: string;
}

export async function validateToken(
  token: string,
  config: EntraConfig,
  jwks: JwksClient,
): Promise<EntraIdentity> {
  // Try multiple audiences — Azure AD may issue tokens with api://clientId or
  // just clientId depending on app registration configuration.
  // AZURE_EXTRA_AUDIENCES supports additional formats such as the Teams
  // federated connector audience (api://auth-{uuid}/{clientId}).
  const audiencesToTry = [
    config.audience,
    config.clientId,
    `api://${config.clientId}`,
    ...config.extraAudiences,
  ].filter((a, i, arr) => arr.indexOf(a) === i); // deduplicate

  let lastError: unknown;

  for (const aud of audiencesToTry) {
    try {
      const { payload } = await jwtVerify<EntraJwtPayload>(token, jwks, {
        issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
        audience: aud,
      });

      // Validate tenant
      if (payload.tid && payload.tid !== config.tenantId) {
        throw new AuthError("Token tenant does not match expected tenant", 401);
      }

      // Validate app role
      const roles: string[] = payload.roles ?? [];
      if (!roles.includes(config.requiredRole)) {
        console.error(
          `[auth] Role check failed — token has roles: [${roles.join(", ")}], required: ${config.requiredRole}`,
        );
        throw new AuthError(
          `Access denied: missing required role '${config.requiredRole}'`,
          403,
        );
      }

      const upn =
        payload.upn ??
        payload.unique_name ??
        payload.preferred_username ??
        payload.sub ??
        "unknown";

      return {
        upn,
        name: payload.name,
        roles,
        oid: payload.oid ?? payload.sub ?? "",
      };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      lastError = err;
    }
  }

  // All audiences failed — log the token's actual aud claim for diagnostics
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const decoded = JSON.parse(
        Buffer.from(parts[1]!, "base64url").toString("utf8"),
      ) as EntraJwtPayload;
      console.error(
        `[auth] JWT validation failed. tokenAudience=${JSON.stringify(decoded.aud)} triedAudiences=${JSON.stringify(audiencesToTry)}`,
      );
    }
  } catch {
    // ignore decode errors
  }

  throw new AuthError(
    `Invalid token: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    401,
  );
}
