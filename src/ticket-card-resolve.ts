/**
 * Resolve the ticket-card payload from a tool result.
 *
 * cw_get_ticket returns a human-readable summary in content[0].text and the
 * ticket + `_card` object in structuredContent. Prefer structuredContent;
 * fall back to JSON-parsing the text block only for older servers that put
 * the whole payload in content (issue #105).
 *
 * Keep the logic in ui/resolve-card.ts in sync — that copy is what vite embeds
 * into the MCP Apps iframe bundle.
 */

export interface ToolResultLike {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

export interface TicketCardLike {
  id: number;
  summary: string;
  notes?: unknown;
}

export function extractCard(obj: unknown): TicketCardLike | null {
  const card = (obj as { _card?: TicketCardLike })?._card;
  return card && typeof card.id === "number" && typeof card.summary === "string"
    ? card
    : null;
}

/** Prefer structuredContent; JSON-parse text only as a legacy fallback. */
export function resolveCardFromToolResult(
  result: ToolResultLike,
): TicketCardLike | null {
  let payload: unknown = result.structuredContent;

  if (payload === undefined) {
    const text = result.content?.find((c) => c.type === "text")?.text;
    if (!text) return null;
    try {
      payload = JSON.parse(text);
    } catch {
      return null;
    }
  }

  const card = extractCard(payload);
  if (!card || !Array.isArray(card.notes)) return null;
  return card;
}
