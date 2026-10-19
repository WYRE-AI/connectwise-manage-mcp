/**
 * Keep in sync with src/ticket-card-resolve.ts — vite bundles this copy into
 * the MCP Apps iframe; the src/ copy is what unit tests import (#105).
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
  if (
    !card ||
    !Array.isArray(card.notes) ||
    !card.notes.every((note) => note !== null && typeof note === "object")
  ) {
    return null;
  }
  return card;
}
