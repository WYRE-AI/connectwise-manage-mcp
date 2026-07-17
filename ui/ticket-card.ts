/**
 * Iframe bridge + renderer for the ConnectWise Manage ticket card
 * (MCP Apps, SEP-1865).
 *
 * Runs inside the host's sandboxed iframe. Uses the official MCP Apps client
 * (`App`) to receive the tool result from the host and to call
 * cw_add_ticket_note back (the "Add note" round-trip).
 *
 * The server attaches a normalized `_card` payload to cw_get_ticket results
 * (see src/card.builder.ts) so this renderer never needs to resolve ids or
 * entity names itself.
 *
 * Rendering uses DOM construction (no innerHTML) — ticket summaries and notes
 * are untrusted PSA data, so text only ever lands in text nodes.
 *
 * White-label: the card is neutral by default (no vendor identity) and applies
 * an injected `window.__BRAND__` override (set by the MCP server via
 * MCP_BRAND_* env vars, or a gateway per-org) so the same card can render in
 * any operator's brand.
 */
import { App } from "@modelcontextprotocol/ext-apps";

interface Brand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}
declare global {
  interface Window {
    __BRAND__?: Brand;
  }
}

/** Mirror of TicketCard in src/card.builder.ts — keep in sync. */
interface TicketCard {
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

const brand: Brand = window.__BRAND__ ?? {};
const brandName = brand.name ?? "";

// Apply any injected brand overrides onto the CSS custom properties.
function applyBrand(): void {
  const root = document.documentElement.style;
  if (brand.primaryColor) root.setProperty("--brand-primary", brand.primaryColor);
  if (brand.accentColor) root.setProperty("--brand-accent", brand.accentColor);
  if (brand.bg) root.setProperty("--brand-bg", brand.bg);
  if (brand.text) root.setProperty("--brand-text", brand.text);
}

const app = new App({ name: "ConnectWise Manage Ticket Card", version: "1.0.0" });
let current: TicketCard | null = null;

/** Create an element with a class and (safe, text-node) children. */
function el(
  tag: string,
  className = "",
  ...children: Array<Node | string | null>
): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child == null) continue;
    node.append(child); // strings become text nodes — never parsed as HTML
  }
  return node;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function field(label: string, value: string | undefined, withDot = false): HTMLElement | null {
  if (!value) return null;
  const valueEl = el("div", withDot ? "field__value board" : "field__value");
  if (withDot) valueEl.append(el("span", "dot"));
  valueEl.append(value);
  return el("div", "field", el("div", "field__label", label), valueEl);
}

function badge(text: string | undefined, cls: string): HTMLElement | null {
  return text ? el("span", `badge ${cls}`, text) : null;
}

function noteEl(n: { who?: string; text: string; internal?: boolean }): HTMLElement {
  return el(
    "div",
    "note",
    n.who ? el("span", "note__title", `${n.who}: `) : null,
    n.text,
    n.internal ? el("span", "note__flag", "internal") : null,
  );
}

function render(t: TicketCard): void {
  current = t;

  // Brand identity only renders when a brand was injected — the neutral
  // default shows just the ticket number/vendor context in the header.
  let brandId: HTMLElement | null = null;
  if (brandName || brand.logoUrl) {
    brandId = el("span", "brandid");
    if (brand.logoUrl) {
      const logo = document.createElement("img");
      logo.src = brand.logoUrl;
      logo.alt = brandName;
      logo.style.display = "inline-block";
      brandId.append(logo);
    }
    if (brandName) brandId.append(el("span", "brand", brandName));
  }

  const notesSection = el("div", "notes", el("div", "notes__h", `Notes (${t.notes.length})`));
  for (const n of t.notes) notesSection.append(noteEl(n));

  if (t.noteDefaults) {
    const input = document.createElement("input");
    input.id = "note-input";
    input.type = "text";
    input.placeholder = "Add an internal note to this ticket…";
    const btn = el("button", "btn", "Add note") as HTMLButtonElement;
    btn.id = "note-btn";

    const submit = async () => {
      const text = input.value.trim();
      if (!text || !current?.noteDefaults) return;
      btn.disabled = true;
      btn.textContent = "Adding…";
      try {
        // The server resolved a safe internal-only visibility default into
        // noteDefaults (internalAnalysisFlag); the card never guesses
        // visibility itself.
        await app.callServerTool({
          name: "cw_add_ticket_note",
          arguments: {
            id: current.id,
            text,
            internalAnalysisFlag: current.noteDefaults.internalAnalysisFlag,
          },
        });
        // The note tool returns the created note, not the ticket — append
        // optimistically and re-render.
        current.notes = [...current.notes, { text, internal: true }];
        render(current);
      } catch {
        btn.disabled = false;
        btn.textContent = "Add note";
      }
    };
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    notesSection.append(el("div", "addnote", input, btn));
  }

  const body = el(
    "div",
    "card__body",
    el("div", "brandrow", brandId, el("span", "ticketno", `#${t.id} · ConnectWise`)),
    el("h1", "", t.summary),
    el("div", "badges", badge(t.status, "badge--status"), badge(t.priority, "badge--prio")),
    el(
      "div",
      "grid",
      field("Company", t.company),
      field("Contact", t.contact),
      field("Owner", t.owner ?? "Unassigned"),
      field("Board", t.board, true),
      field("Entered", t.dateEntered && fmtDate(t.dateEntered)),
      field("Required by", t.requiredDate && fmtDate(t.requiredDate)),
    ),
    notesSection,
  );

  const root = document.getElementById("root")!;
  root.replaceChildren(el("div", "card", el("div", "card__bar"), body));
}

// connectwise-manage-mcp returns the ticket JSON directly and attaches the
// normalized card to cw_get_ticket results as _card.
function extractCard(obj: unknown): TicketCard | null {
  const card = (obj as { _card?: TicketCard })?._card;
  return card && typeof card.id === "number" && typeof card.summary === "string" ? card : null;
}

applyBrand();

// Must be set before connect() so the initial tool-result isn't missed.
app.ontoolresult = (result: { content?: Array<{ type: string; text?: string }> }) => {
  const payload = (result.content ?? []).find((c) => c.type === "text");
  if (!payload?.text) return;
  try {
    const card = extractCard(JSON.parse(payload.text));
    if (card) render(card);
  } catch {
    /* ignore malformed payloads */
  }
};

app.connect();
