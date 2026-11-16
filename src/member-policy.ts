/**
 * Member attribution policy.
 *
 * ConnectWise attributes a note or time entry to the API member that
 * authenticated the request unless the body carries `member: { id }`. This
 * module decides which member id (if any) a write tool sends, so a deployment
 * can pin every write to a real technician instead of the shared API member.
 *
 * Sources, by transport:
 *   env mode     CW_MANAGE_MEMBER_ID / CW_MANAGE_FORCE_MEMBER_ID
 *   gateway mode X-CW-Member-Id / X-CW-Force-Member-Id (per request)
 *
 * Semantics:
 *   memberId unset            -> caller's memberId is used as given (upstream behaviour)
 *   memberId set, not forced  -> caller's memberId wins; the policy fills it in when omitted
 *   memberId set, forced      -> the policy's memberId is always sent; a caller value is ignored
 *
 * Forcing is what makes attribution trustworthy: the model cannot pick a
 * different technician no matter what the prompt says.
 */

export interface MemberPolicy {
  /** Member id to attribute writes to, when configured. */
  memberId?: number;
  /** When true, `memberId` overrides any caller-supplied value. */
  forced: boolean;
}

export const EMPTY_MEMBER_POLICY: MemberPolicy = Object.freeze({ forced: false });

/** Parse a member id from an env var or header. Returns undefined on blank or non-positive-integer input. */
export function parseMemberId(raw: string | undefined): number | undefined {
  const s = (raw ?? "").trim();
  if (!s) return undefined;
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Parse a boolean flag. Accepts true/1/yes (case-insensitive). */
export function parseForceFlag(raw: string | undefined): boolean {
  const s = (raw ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/**
 * Build a policy from raw string inputs. Returns undefined when no valid
 * member id is present (so an unconfigured server carries no policy at all),
 * which also means a force flag without a member id is dropped: a
 * misconfiguration fails loudly at the tool call rather than silently
 * stripping attribution.
 */
export function buildMemberPolicy(
  memberIdRaw: string | undefined,
  forceRaw: string | undefined,
): MemberPolicy | undefined {
  const memberId = parseMemberId(memberIdRaw);
  if (memberId === undefined) return undefined;
  return { memberId, forced: parseForceFlag(forceRaw) };
}

export interface ResolvedMember {
  memberId?: number;
  /** True when the caller supplied a different id and the policy overrode it. */
  overrode: boolean;
}

/**
 * Decide the member id to send for one write.
 */
export function resolveMemberId(
  policy: MemberPolicy | undefined,
  requested: number | undefined,
): ResolvedMember {
  const p = policy ?? EMPTY_MEMBER_POLICY;
  if (p.memberId !== undefined && p.forced) {
    return {
      memberId: p.memberId,
      overrode: requested !== undefined && requested !== p.memberId,
    };
  }
  return { memberId: requested ?? p.memberId, overrode: false };
}

/** Text a write tool adds to its result when the policy replaced the caller's memberId. */
export function memberOverrideNotice(requested: number | undefined, sent: number | undefined): string {
  return `Note: memberId ${String(requested)} was ignored; this server forces member id ${String(sent)}.`;
}

/** One-line description of the policy for tool descriptions / diagnostics. */
export function describeMemberPolicy(policy: MemberPolicy | undefined): string {
  const p = policy ?? EMPTY_MEMBER_POLICY;
  if (p.memberId === undefined) return "no server member policy; memberId is sent only when you pass it";
  return p.forced
    ? `server forces member id ${p.memberId} on every note and time entry; a passed memberId is ignored`
    : `server defaults memberId to ${p.memberId} when omitted`;
}
