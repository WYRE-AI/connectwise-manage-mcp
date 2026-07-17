/**
 * Ticket-card payload builder for the MCP Apps (SEP-1865) UI surface.
 *
 * cw_get_ticket results get a normalized `_card` object attached (see
 * tools/tickets.ts) that the ui:// ticket card renders from. The card is
 * progressive enhancement: every step here is best-effort, and a null
 * return simply means the host renders no card while the JSON payload is
 * unchanged.
 */

export const TICKET_CARD_RESOURCE_URI = "ui://connectwise-manage/ticket-card.html";

/** MCP Apps resource MIME (RESOURCE_MIME_TYPE in @modelcontextprotocol/ext-apps). */
export const MCP_APP_RESOURCE_MIME = "text/html;profile=mcp-app";

/**
 * Tool `_meta` advertising the card. Carries both the canonical flat key
 * (RESOURCE_URI_META_KEY in ext-apps) and the nested form ext-apps'
 * registerAppTool emits, so any MCP Apps host revision finds it.
 */
export const TICKET_CARD_META = {
  "ui/resourceUri": TICKET_CARD_RESOURCE_URI,
  ui: { resourceUri: TICKET_CARD_RESOURCE_URI },
} as const;

/** Brand overrides injected into the card as `window.__BRAND__`. */
export interface CardBrand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}

/** The BRAND_INJECT comment marker baked into the card HTML (see ui/index.html). */
const BRAND_INJECT_RE = /<!--\s*BRAND_INJECT:[\s\S]*?-->/;

/**
 * Serve-time brand injection: replace the BRAND_INJECT marker with an inline
 * `window.__BRAND__` script so self-hosters can theme the card without
 * rebuilding the bundle. An empty brand returns the HTML unchanged (the card
 * renders its neutral defaults). `<` is escaped so brand values can never
 * break out of the script tag.
 */
export function applyBrandInjection(html: string, brand: CardBrand): string {
  if (!brand || Object.values(brand).every((v) => !v)) return html;
  const json = JSON.stringify(brand).replace(/</g, "\\u003c");
  return html.replace(BRAND_INJECT_RE, `<script>window.__BRAND__=${json}</script>`);
}

/**
 * Resolve brand overrides from MCP_BRAND_* environment variables. Guarded for
 * runtimes without `process` (Cloudflare Workers), where this returns an empty
 * brand and the card serves its neutral defaults.
 */
export function resolveBrandFromEnv(): CardBrand {
  if (typeof process === "undefined" || !process.env) return {};
  const env = process.env;
  const brand: CardBrand = {};
  if (env.MCP_BRAND_NAME) brand.name = env.MCP_BRAND_NAME;
  if (env.MCP_BRAND_LOGO_URL) brand.logoUrl = env.MCP_BRAND_LOGO_URL;
  if (env.MCP_BRAND_PRIMARY_COLOR) brand.primaryColor = env.MCP_BRAND_PRIMARY_COLOR;
  if (env.MCP_BRAND_ACCENT_COLOR) brand.accentColor = env.MCP_BRAND_ACCENT_COLOR;
  if (env.MCP_BRAND_BG) brand.bg = env.MCP_BRAND_BG;
  if (env.MCP_BRAND_TEXT) brand.text = env.MCP_BRAND_TEXT;
  return brand;
}

/** Mirror of TicketCard in ui/ticket-card.ts — keep in sync. */
export interface TicketCard {
  id: number;
  summary: string;
  status?: string;
  priority?: string;
  company?: string;
  contact?: string;
  owner?: string;
  board?: string;
  dateEntered?: string;
  requiredDate?: string;
  notes: Array<{ who?: string; text: string; internal?: boolean }>;
  noteDefaults?: { internalAnalysisFlag: boolean };
}

const CARD_NOTE_LIMIT = 5;
const CARD_NOTE_MAX_LENGTH = 500;

/**
 * Resolve a display label for a ConnectWise entity reference: the API returns
 * nested `{ id, name, identifier }` refs, so prefer the resolved name and fall
 * back to the identifier, then `#id`.
 */
function refLabel(ref: unknown): string | undefined {
  if (!ref || typeof ref !== "object") return undefined;
  const r = ref as { name?: unknown; identifier?: unknown; id?: unknown };
  if (typeof r.name === "string" && r.name) return r.name;
  if (typeof r.identifier === "string" && r.identifier) return r.identifier;
  if (r.id != null) return `#${r.id}`;
  return undefined;
}

/** Shape of a ConnectWise service ticket note, as far as the card cares. */
interface CwNote {
  text?: unknown;
  member?: unknown;
  contact?: unknown;
  createdBy?: unknown;
  internalAnalysisFlag?: unknown;
}

/**
 * The slice of CwManageClient the builder needs (structural, so tests can
 * pass a plain mock).
 */
export interface CardDataClient {
  get(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<unknown>;
}

/**
 * Build the renderable card from a cw_get_ticket payload. ConnectWise resolves
 * entity names inline (nested `{ id, name }` refs), so no extra lookups are
 * needed; recent notes are fetched best-effort so the card has visible note
 * context. Never throws — any failure degrades or drops the card.
 */
export async function buildTicketCard(
  ticket: Record<string, unknown>,
  client: CardDataClient,
): Promise<TicketCard | null> {
  try {
    if (typeof ticket?.id !== "number" || typeof ticket.summary !== "string" || !ticket.summary) {
      return null;
    }

    const card: TicketCard = {
      id: ticket.id,
      summary: ticket.summary,
      notes: [],
      // ConnectWise marks internal-only notes with internalAnalysisFlag —
      // "Internal Analysis" notes are never shown in the customer portal, so
      // an internal-only default is always safe. The card never guesses
      // visibility itself.
      noteDefaults: { internalAnalysisFlag: true },
    };

    const status = refLabel(ticket.status);
    const priority = refLabel(ticket.priority);
    const company = refLabel(ticket.company);
    const contact = refLabel(ticket.contact);
    const owner = refLabel(ticket.owner);
    const board = refLabel(ticket.board);
    if (status) card.status = status;
    if (priority) card.priority = priority;
    if (company) card.company = company;
    if (contact) card.contact = contact;
    if (owner) card.owner = owner;
    if (board) card.board = board;

    const info = ticket._info as { dateEntered?: unknown } | undefined;
    if (info && typeof info.dateEntered === "string") card.dateEntered = info.dateEntered;
    if (typeof ticket.requiredDate === "string") card.requiredDate = ticket.requiredDate;

    // Recent notes give the card (and its add-note round-trip) visible context.
    try {
      const notes = (await client.get(`/service/tickets/${ticket.id}/notes`, {
        pageSize: CARD_NOTE_LIMIT,
        orderBy: "dateCreated desc",
      })) as CwNote[];
      if (Array.isArray(notes)) {
        // Fetched newest-first; reverse so the card reads oldest-to-newest.
        card.notes = notes
          .filter((n) => n && typeof n.text === "string" && n.text)
          .slice(0, CARD_NOTE_LIMIT)
          .reverse()
          .map((n) => {
            const note: TicketCard["notes"][number] = {
              text: String(n.text).slice(0, CARD_NOTE_MAX_LENGTH),
            };
            const who =
              refLabel(n.member) ??
              refLabel(n.contact) ??
              (typeof n.createdBy === "string" && n.createdBy ? n.createdBy : undefined);
            if (who) note.who = who;
            if (n.internalAnalysisFlag === true) note.internal = true;
            return note;
          });
      }
    } catch {
      // Best-effort: render the card without notes rather than failing the tool.
    }

    return card;
  } catch {
    // Card building is progressive enhancement — never fail the tool result.
    return null;
  }
}
