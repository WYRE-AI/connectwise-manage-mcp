/**
 * Service note write body and create-response mapping.
 *
 * Manage API ServiceNote (ConnectWise Manage Public Endpoints; the generated
 * 2025.8 client and the 2025.16 contract this repo cites for other resources):
 * - Note type is `detailDescriptionFlag`, `internalAnalysisFlag`, `resolutionFlag`.
 * - `processNotifications` is the only ServiceNote field that sends notifications.
 *   When it is true, Manage emails using the ticket's `automaticEmailContactFlag`,
 *   `automaticEmailResourceFlag`, `automaticEmailCcFlag`, and `automaticEmailCc`.
 * - `member` is a MemberReference (`{ id }`). It sets the note author. Omit it
 *   and Manage attributes the note to the API member that authenticated the call.
 * - `emailContactFlag`, `emailResourceFlag`, `emailCcFlag`, and `emailCc` are
 *   NOT ServiceNote properties. They are TimeEntry action flags (and the ticket
 *   stores the same choices as `automaticEmail*`). POST /service/tickets/{id}/notes
 *   rejects a body that includes them with 400. They are never copied onto the
 *   note. A true flag only requests `processNotifications`, and only when the
 *   caller set that flag. An explicit `processNotifications` value wins.
 * - Nothing is emailed unless `processNotifications` is true. Omitted email
 *   flags are not defaulted to true and are not sent.
 */

export interface TicketNoteInput {
  text: string;
  detailDescriptionFlag?: boolean;
  internalAnalysisFlag?: boolean;
  resolutionFlag?: boolean;
  customerUpdatedFlag?: boolean;
  /** Not a ServiceNote field. true requests processNotifications; never sent. */
  emailContactFlag?: boolean;
  /** Not a ServiceNote field. true requests processNotifications; never sent. */
  emailResourceFlag?: boolean;
  /** Not a ServiceNote field. true requests processNotifications; never sent. */
  emailCcFlag?: boolean;
  /**
   * Not a ServiceNote field (TimeEntry.emailCc / Ticket.automaticEmailCc).
   * Never sent on the note. Does not by itself enable processNotifications.
   */
  emailCc?: string;
  processNotifications?: boolean;
  /** Sent as ServiceNote.member.id only when the caller sets it. */
  memberId?: number;
}

const PASSTHROUGH_KEYS = [
  "detailDescriptionFlag",
  "internalAnalysisFlag",
  "resolutionFlag",
  "customerUpdatedFlag",
  "processNotifications",
] as const satisfies readonly (keyof TicketNoteInput)[];

/** Field names that 400 on POST /service/tickets/{id}/notes. Never written. */
export const SERVICE_NOTE_REJECTED_EMAIL_FIELDS = [
  "emailContactFlag",
  "emailResourceFlag",
  "emailCcFlag",
  "emailCc",
] as const;

export function buildTicketNoteBody(input: TicketNoteInput): Record<string, unknown> {
  const body: Record<string, unknown> = { text: input.text };
  for (const key of PASSTHROUGH_KEYS) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  if (input.memberId !== undefined) body.member = { id: input.memberId };

  // An explicit processNotifications value wins, including false.
  // Otherwise turn delivery on only when a recipient flag is explicitly true.
  // The flag names themselves stay off the body: ServiceNote has no such fields.
  const wantsEmail =
    input.emailContactFlag === true ||
    input.emailResourceFlag === true ||
    input.emailCcFlag === true;
  if (input.processNotifications === undefined && wantsEmail) {
    body.processNotifications = true;
  }

  // Manage returns 400 ("Please choose where to display the notes") when a
  // note is saved for notification with none of the type flags set. Text-only
  // notes (no notification) are left unchanged. An explicit type flag is kept.
  const displaySpecified =
    input.detailDescriptionFlag !== undefined ||
    input.internalAnalysisFlag !== undefined ||
    input.resolutionFlag !== undefined;
  if (body.processNotifications === true && !displaySpecified) {
    body.detailDescriptionFlag = true;
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
