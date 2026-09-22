/**
 * Service note write body and create-response mapping.
 *
 * Manage API (ServiceNote, OpenAPI 2025.16):
 * - Note type is `detailDescriptionFlag`, `internalAnalysisFlag`, `resolutionFlag`.
 * - `processNotifications` is the ServiceNote field that sends notifications.
 * - `emailContactFlag`, `emailResourceFlag`, `emailCcFlag`, and `emailCc` are the
 *   per-note recipient fields. TimeEntry documents the same names as action
 *   flags and points updates at the ticket's `automaticEmail*` fields. They
 *   are forwarded on the note POST only when the caller sets them.
 * - Nothing is emailed unless the caller sets an email flag or
 *   `processNotifications`. Omitted flags are not sent and are not defaulted on.
 */

export interface TicketNoteInput {
  text: string;
  detailDescriptionFlag?: boolean;
  internalAnalysisFlag?: boolean;
  resolutionFlag?: boolean;
  customerUpdatedFlag?: boolean;
  emailContactFlag?: boolean;
  emailResourceFlag?: boolean;
  emailCcFlag?: boolean;
  emailCc?: string;
  processNotifications?: boolean;
}

const PASSTHROUGH_KEYS = [
  "detailDescriptionFlag",
  "internalAnalysisFlag",
  "resolutionFlag",
  "customerUpdatedFlag",
  "emailContactFlag",
  "emailResourceFlag",
  "emailCcFlag",
  "emailCc",
  "processNotifications",
] as const satisfies readonly (keyof TicketNoteInput)[];

export function buildTicketNoteBody(input: TicketNoteInput): Record<string, unknown> {
  const body: Record<string, unknown> = { text: input.text };
  for (const key of PASSTHROUGH_KEYS) {
    if (input[key] !== undefined) body[key] = input[key];
  }

  // An explicit processNotifications value wins, including false.
  // Otherwise turn delivery on only when a recipient flag is explicitly true.
  const wantsEmail =
    input.emailContactFlag === true ||
    input.emailResourceFlag === true ||
    input.emailCcFlag === true;
  if (input.processNotifications === undefined && wantsEmail) {
    body.processNotifications = true;
  }

  return body;
}

export interface NoteVisibilityRequest {
  detailDescriptionFlag?: boolean;
  internalAnalysisFlag?: boolean;
  resolutionFlag?: boolean;
}

function storedTypeFlag(
  record: Record<string, unknown>,
  key: string,
  requested?: boolean,
): boolean {
  const value = record[key];
  if (typeof value === "boolean") return value;
  return requested === true;
}

/**
 * Manage's note-create response echoes `internalFlag: true` and
 * `externalFlag: true` together, including on notes that were stored as
 * internal-only. A later GET returns both fields as null. Recompute them
 * from the note-type flags that were actually stored so the echo does not
 * claim both visibilities.
 *
 * - internal: `internalAnalysisFlag`
 * - external: discussion (`detailDescriptionFlag`), resolution, or issue
 * - no type flags stored: both null, matching read-back
 */
export function mapCreatedNoteResponse<T>(
  note: T,
  requested?: NoteVisibilityRequest,
): T {
  if (!note || typeof note !== "object" || Array.isArray(note)) return note;
  const record = note as Record<string, unknown>;

  const detail = storedTypeFlag(record, "detailDescriptionFlag", requested?.detailDescriptionFlag);
  const internal = storedTypeFlag(record, "internalAnalysisFlag", requested?.internalAnalysisFlag);
  const resolution = storedTypeFlag(record, "resolutionFlag", requested?.resolutionFlag);
  const issue = storedTypeFlag(record, "issueFlag");

  const typeFlagPresent =
    typeof record.detailDescriptionFlag === "boolean" ||
    typeof record.internalAnalysisFlag === "boolean" ||
    typeof record.resolutionFlag === "boolean" ||
    typeof record.issueFlag === "boolean" ||
    requested?.detailDescriptionFlag !== undefined ||
    requested?.internalAnalysisFlag !== undefined ||
    requested?.resolutionFlag !== undefined;

  if (!typeFlagPresent && !detail && !internal && !resolution && !issue) {
    return { ...record, internalFlag: null, externalFlag: null } as T;
  }

  return {
    ...record,
    internalFlag: internal,
    externalFlag: detail || resolution || issue,
  } as T;
}
