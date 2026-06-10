export interface EntraConfig {
  tenantId: string;
  clientId: string;
  audience: string; // api://<clientId>
  extraAudiences: string[]; // additional accepted audiences (e.g. Teams federated connector)
  requiredRole: string; // e.g. "CWM.Access"
  serverUrl: string; // https://mcp.yourdomain.com (no trailing slash)
  bearerToken?: string; // static token for Claude Code CLI fallback
}

export interface EntraIdentity {
  upn: string;
  name?: string;
  roles: string[];
  oid: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 401 | 403,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
