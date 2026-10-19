/**
 * UI payload resolution for the MCP Apps ticket card (#105).
 *
 * cw_get_ticket puts a human-readable summary in content[0].text and the
 * ticket + `_card` in structuredContent. The iframe must prefer
 * structuredContent; parsing the summary text as JSON always fails.
 */
import { describe, it, expect } from "vitest";
import { resolveCardFromToolResult } from "../ticket-card-resolve.js";
import { TICKET_CARD_HTML } from "../generated/ticket-card-html.js";

const card = {
  id: 77,
  summary: "Server offline",
  status: "New",
  notes: [{ who: "druiz", text: "First note" }],
};

describe("resolveCardFromToolResult (#105)", () => {
  it("reads _card from structuredContent (current server shape)", () => {
    const resolved = resolveCardFromToolResult({
      content: [
        {
          type: "text",
          text: "Ticket #77: Server offline (no priority, New)",
        },
      ],
      structuredContent: { id: 77, summary: "Server offline", _card: card },
    });
    expect(resolved).toEqual(card);
  });

  it("does not try to JSON-parse the human-readable summary", () => {
    const resolved = resolveCardFromToolResult({
      content: [
        {
          type: "text",
          text: "Ticket #77: Server offline (no priority, New)",
        },
      ],
    });
    expect(resolved).toBeNull();
  });

  it("falls back to JSON-parsing content text for legacy payloads", () => {
    const resolved = resolveCardFromToolResult({
      content: [
        {
          type: "text",
          text: JSON.stringify({ id: 77, summary: "legacy", _card: card }),
        },
      ],
    });
    expect(resolved).toEqual(card);
  });

  it("ignores a card without a notes array", () => {
    const resolved = resolveCardFromToolResult({
      structuredContent: {
        _card: { id: 1, summary: "no notes field" },
      },
    });
    expect(resolved).toBeNull();
  });

  it("returns null when there is no usable payload", () => {
    expect(resolveCardFromToolResult({})).toBeNull();
    expect(
      resolveCardFromToolResult({
        content: [{ type: "text", text: "not-json{" }],
      }),
    ).toBeNull();
  });

  it("embeds structuredContent handling in the built card HTML", () => {
    // Guards against forgetting npm run build:ui after editing ui/resolve-card.ts.
    expect(TICKET_CARD_HTML).toContain("structuredContent");
  });
});
