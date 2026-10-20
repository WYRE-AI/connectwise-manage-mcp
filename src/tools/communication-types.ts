import type { CwManageClient } from "../api-client.js";

/** A record from GET /company/communicationTypes. */
export interface CommunicationTypeRecord {
  id?: number;
  description?: string;
  name?: string;
  emailFlag?: boolean;
  phoneFlag?: boolean;
  faxFlag?: boolean;
  defaultFlag?: boolean;
}

export type CommunicationKind = "email" | "phone";

export interface ResolvedCommunicationType {
  id: number;
  name?: string;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
const MAX_LISTED_TYPES = 25;

const cache = new Map<string, { expires: number; types: CommunicationTypeRecord[] }>();

/** Test helper: drop every cached communication type list. */
export function clearCommunicationTypeCache(): void {
  cache.clear();
}

export function typeLabel(type: CommunicationTypeRecord): string {
  return (type.description ?? type.name ?? "").trim();
}

function isUsable(type: CommunicationTypeRecord): type is CommunicationTypeRecord & { id: number } {
  return typeof type.id === "number";
}

function matchesLabel(type: CommunicationTypeRecord, wanted: string): boolean {
  const w = wanted.trim().toLowerCase();
  return [type.description, type.name].some((v) => typeof v === "string" && v.trim().toLowerCase() === w);
}

function toResolved(type: CommunicationTypeRecord & { id: number }): ResolvedCommunicationType {
  const name = typeLabel(type);
  return name ? { id: type.id, name } : { id: type.id };
}

function lowestId(types: Array<CommunicationTypeRecord & { id: number }>) {
  return types.reduce((best, t) => (t.id < best.id ? t : best));
}

/** Pick the type to use for email, or undefined when the tenant has none. */
export function pickEmailType(types: CommunicationTypeRecord[]): ResolvedCommunicationType | undefined {
  const usable = types.filter(isUsable);
  const flagged = usable.filter((t) => t.emailFlag === true);
  if (flagged.length) {
    const pool = flagged.filter((t) => t.defaultFlag === true);
    const byName = flagged.filter((t) => matchesLabel(t, "Email"));
    return toResolved(lowestId(pool.length ? pool : byName.length ? byName : flagged));
  }
  const named = usable.filter((t) => matchesLabel(t, "email") || matchesLabel(t, "e-mail"));
  return named.length ? toResolved(lowestId(named)) : undefined;
}

/** Pick the type to use for phone, or undefined when the tenant has none. */
export function pickPhoneType(types: CommunicationTypeRecord[]): ResolvedCommunicationType | undefined {
  const usable = types.filter(isUsable);
  const flagged = usable.filter((t) => t.phoneFlag === true);
  if (flagged.length) {
    const direct = flagged.filter((t) => matchesLabel(t, "Direct"));
    if (direct.length) return toResolved(lowestId(direct));
    const defaults = flagged.filter((t) => t.defaultFlag === true);
    return toResolved(defaults.length ? lowestId(defaults) : flagged[0]);
  }
  const named = usable.filter((t) => ["direct", "phone", "office"].some((n) => matchesLabel(t, n)));
  return named.length ? toResolved(named[0]) : undefined;
}

/** Case-insensitive match of a caller-supplied name on description or name. */
export function findTypeByName(
  types: CommunicationTypeRecord[],
  name: string,
): ResolvedCommunicationType | undefined {
  const match = types.filter(isUsable).find((t) => matchesLabel(t, name));
  return match ? toResolved(match) : undefined;
}

export function describeAvailableTypes(types: CommunicationTypeRecord[], kind?: CommunicationKind): string {
  const usable = types.filter(isUsable);
  const flagKey = kind === "email" ? "emailFlag" : kind === "phone" ? "phoneFlag" : undefined;
  const ofKind = flagKey ? usable.filter((t) => t[flagKey] === true) : usable;
  const list = ofKind.length ? ofKind : usable;
  if (!list.length) return "none";
  const shown = list.slice(0, MAX_LISTED_TYPES).map((t) => `${t.id} (${typeLabel(t) || "unnamed"})`);
  const more = list.length > MAX_LISTED_TYPES ? `, and ${list.length - MAX_LISTED_TYPES} more` : "";
  return shown.join(", ") + more;
}

export function unresolvedTypeError(kind: CommunicationKind, types: CommunicationTypeRecord[]): Error {
  const flag = kind === "email" ? "emailFlag" : "phoneFlag";
  const names = kind === "email" ? '"Email"' : '"Direct" or "Phone"';
  return new Error(
    `No ${kind} communication type found in ConnectWise (GET /company/communicationTypes returned no type with ${flag}=true or a name like ${names}). ` +
      `Pass ${kind}TypeId or ${kind}TypeName. Available types: ${describeAvailableTypes(types)}`,
  );
}

function unknownNameError(kind: CommunicationKind, name: string, types: CommunicationTypeRecord[]): Error {
  return new Error(
    `No ${kind} communication type named "${name}" in ConnectWise. Available ${kind} types: ${describeAvailableTypes(types, kind)}`,
  );
}

function asRecords(value: unknown): CommunicationTypeRecord[] {
  return Array.isArray(value) ? (value as CommunicationTypeRecord[]) : [];
}

/** Fetch the tenant's communication types, cached per connection (api base + company id). */
export async function getCommunicationTypes(client: CwManageClient): Promise<CommunicationTypeRecord[]> {
  const key = client.connectionKey;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.types;
  if (hit) cache.delete(key);

  const types = asRecords(await client.get<unknown>("/company/communicationTypes", { pageSize: 1000 }));
  cache.delete(key);
  // An empty list is not cached, so a tenant that adds its first type (or a
  // transient empty response) is picked up on the next call.
  if (types.length === 0) return types;
  cache.set(key, { expires: now + CACHE_TTL_MS, types });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return types;
}

export interface CommunicationTypeRequest {
  email?: { wanted: boolean; typeId?: number; typeName?: string };
  phone?: { wanted: boolean; typeId?: number; typeName?: string };
}

/**
 * Resolve the type for each wanted kind. Caller id wins over caller name,
 * which wins over auto-detection. The type list is only fetched when
 * something needs it.
 */
export async function resolveCommunicationTypes(
  client: CwManageClient,
  request: CommunicationTypeRequest,
): Promise<Partial<Record<CommunicationKind, ResolvedCommunicationType>>> {
  const out: Partial<Record<CommunicationKind, ResolvedCommunicationType>> = {};
  const pending: CommunicationKind[] = [];
  for (const kind of ["email", "phone"] as const) {
    const r = request[kind];
    if (!r?.wanted) continue;
    if (r.typeId !== undefined) out[kind] = { id: r.typeId };
    else pending.push(kind);
  }
  if (!pending.length) return out;

  const types = await getCommunicationTypes(client);
  for (const kind of pending) {
    const r = request[kind]!;
    const name = r.typeName?.trim();
    if (name) {
      const found = findTypeByName(types, name);
      if (!found) throw unknownNameError(kind, name, types);
      out[kind] = found;
      continue;
    }
    const picked = kind === "email" ? pickEmailType(types) : pickPhoneType(types);
    if (!picked) throw unresolvedTypeError(kind, types);
    out[kind] = picked;
  }
  return out;
}
