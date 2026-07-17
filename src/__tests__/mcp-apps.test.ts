/**
 * MCP Apps (SEP-1865) contract tests — mirrors the checks an MCP Apps host
 * performs to render the ticket card:
 *   1. renderable tools advertise the UI resource via _meta (both key forms)
 *   2. the ui:// resource lists and reads back as profile=mcp-app HTML
 *   3. buildTicketCard normalizes a ConnectWise ticket into the card payload
 *      the iframe renders from, with a safe internal-only note default
 *   4. cw_get_ticket attaches _card end-to-end without touching the payload
 *
 * Wire-level checks drive the Cloudflare Workers entrypoint (same MCP server
 * factory as stdio / Node HTTP), like worker.test.ts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";
import {
  buildTicketCard,
  applyBrandInjection,
  TICKET_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
} from "../card.builder.js";
import { TICKET_CARD_HTML } from "../generated/ticket-card-html.js";

const RENDERABLE_TOOLS = ["cw_get_ticket", "cw_add_ticket_note"];

const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  // Gateway credentials so the full tool set registers (no API calls happen
  // for tools/list, resources/list, or resources/read).
  "X-CW-Company-Id": "acme",
  "X-CW-Public-Key": "pub",
  "X-CW-Private-Key": "priv",
  "X-CW-Client-Id": "client-guid",
};

async function mcp(body: unknown): Promise<unknown> {
  const res = await worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(body),
    }),
    { AUTH_MODE: "gateway" },
  );
  expect(res.status).toBe(200);
  return res.json();
}

interface ToolEntry {
  name: string;
  _meta?: Record<string, unknown>;
}

async function listTools(): Promise<ToolEntry[]> {
  const body = (await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  })) as { result?: { tools?: ToolEntry[] } };
  return body.result?.tools ?? [];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("MCP Apps ticket card", () => {
  describe("tool _meta advertisement", () => {
    it.each(RENDERABLE_TOOLS)("%s links the card via _meta", async (name) => {
      const tool = (await listTools()).find((t) => t.name === name);
      expect(tool).toBeDefined();
      // Canonical flat key (ext-apps RESOURCE_URI_META_KEY) …
      expect(tool?._meta?.["ui/resourceUri"]).toBe(TICKET_CARD_RESOURCE_URI);
      // … and the nested form registerAppTool also emits.
      expect((tool?._meta?.ui as { resourceUri?: string })?.resourceUri).toBe(
        TICKET_CARD_RESOURCE_URI,
      );
    });

    it("no other tools carry UI metadata", async () => {
      const others = (await listTools()).filter(
        (t) => t._meta && !RENDERABLE_TOOLS.includes(t.name),
      );
      expect(others).toEqual([]);
    });
  });

  describe("ui:// resource", () => {
    it("is listed with the MCP Apps MIME type", async () => {
      const body = (await mcp({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/list",
        params: {},
      })) as { result?: { resources?: { uri: string; mimeType?: string }[] } };
      const card = (body.result?.resources ?? []).find(
        (r) => r.uri === TICKET_CARD_RESOURCE_URI,
      );
      expect(card?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
    });

    it("reads back as profile=mcp-app HTML containing the card app", async () => {
      const body = (await mcp({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: TICKET_CARD_RESOURCE_URI },
      })) as { result?: { contents?: { mimeType?: string; text?: string }[] } };
      const content = body.result?.contents?.[0];
      expect(content?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
      // No MCP_BRAND_* env set → the embedded HTML is served byte-identical.
      expect(content?.text).toBe(TICKET_CARD_HTML);
      expect(content?.text).toContain("card__bar");
      expect(content?.text).toContain("BRAND_INJECT");
      // The vite build must have inlined the bridge script — a bare <script src>
      // would be unloadable from a resources/read HTML string.
      expect(content?.text).not.toContain('src="./ticket-card.ts"');
    });

    it("serves neutral defaults with no vendor identity", () => {
      expect(TICKET_CARD_HTML).not.toMatch(/WYRE/i);
      expect(TICKET_CARD_HTML).not.toContain("00c9db"); // WYRE cyan
      expect(TICKET_CARD_HTML).not.toContain("ede947"); // WYRE yellow
      expect(TICKET_CARD_HTML).not.toContain("fonts.googleapis.com"); // no external fetches
      // Exactly one injection marker for serve-time branding.
      expect(TICKET_CARD_HTML.match(/BRAND_INJECT/g)).toHaveLength(1);
    });

    it("injects MCP_BRAND_* env vars into the served HTML", async () => {
      vi.stubEnv("MCP_BRAND_NAME", "Acme MSP");
      vi.stubEnv("MCP_BRAND_PRIMARY_COLOR", "#ff0000");
      const body = (await mcp({
        jsonrpc: "2.0",
        id: 4,
        method: "resources/read",
        params: { uri: TICKET_CARD_RESOURCE_URI },
      })) as { result?: { contents?: { text?: string }[] } };
      const text = body.result?.contents?.[0]?.text ?? "";
      expect(text).toContain(
        '<script>window.__BRAND__={"name":"Acme MSP","primaryColor":"#ff0000"}</script>',
      );
      expect(text).not.toContain("BRAND_INJECT");
    });

    it("rejects unknown resource URIs", async () => {
      const body = (await mcp({
        jsonrpc: "2.0",
        id: 5,
        method: "resources/read",
        params: { uri: "ui://connectwise-manage/nope.html" },
      })) as { error?: { message?: string } };
      expect(body.error?.message).toMatch(/not found/i);
    });
  });

  describe("applyBrandInjection", () => {
    const html = TICKET_CARD_HTML;

    it("replaces the marker with an inline window.__BRAND__ script", () => {
      const out = applyBrandInjection(html, { name: "Acme", primaryColor: "#123456" });
      expect(out).toContain('window.__BRAND__={"name":"Acme","primaryColor":"#123456"}');
      expect(out).not.toContain("BRAND_INJECT");
    });

    it("escapes < so brand values cannot break out of the script tag", () => {
      const out = applyBrandInjection(html, { name: "</script><script>alert(1)" });
      expect(out).not.toContain("</script><script>alert(1)");
      expect(out).toContain("\\u003c/script>\\u003cscript>alert(1)");
    });

    it("returns the HTML unchanged for an empty brand", () => {
      expect(applyBrandInjection(html, {})).toBe(html);
      expect(applyBrandInjection(html, { name: "" })).toBe(html);
    });
  });

  describe("buildTicketCard", () => {
    const ticket = {
      id: 4821,
      summary: "VPN outage — main office",
      status: { id: 1, name: "New" },
      priority: { id: 2, name: "Priority 1 - Critical" },
      company: { id: 12, identifier: "acme", name: "Acme Corp" },
      contact: { id: 9, name: "Jane Doe" },
      owner: { id: 7, identifier: "druiz", name: "Dana Ruiz" },
      board: { id: 3, name: "Service Board" },
      requiredDate: "2026-07-18T17:00:00Z",
      _info: { dateEntered: "2026-07-17T09:00:00Z" },
    };

    const notes = [
      {
        id: 2,
        text: "Escalated to network team",
        member: { id: 7, name: "Dana Ruiz" },
        internalAnalysisFlag: true,
      },
      { id: 1, text: "Customer reported outage", contact: { id: 9, name: "Jane Doe" } },
    ];

    const client = { get: vi.fn(async () => notes) };

    it("normalizes labels, names, and notes into the card payload", async () => {
      const card = await buildTicketCard(ticket, client);
      expect(card).toMatchObject({
        id: 4821,
        summary: "VPN outage — main office",
        status: "New",
        priority: "Priority 1 - Critical",
        company: "Acme Corp",
        contact: "Jane Doe",
        owner: "Dana Ruiz",
        board: "Service Board",
        dateEntered: "2026-07-17T09:00:00Z",
        requiredDate: "2026-07-18T17:00:00Z",
        // Fetched newest-first, rendered oldest-first.
        notes: [
          { who: "Jane Doe", text: "Customer reported outage" },
          { who: "Dana Ruiz", text: "Escalated to network team", internal: true },
        ],
      });
      expect(client.get).toHaveBeenCalledWith(
        "/service/tickets/4821/notes",
        expect.objectContaining({ pageSize: 5 }),
      );
    });

    it("defaults the add-note round-trip to internal-only visibility", async () => {
      const card = await buildTicketCard(ticket, client);
      expect(card?.noteDefaults).toEqual({ internalAnalysisFlag: true });
    });

    it("falls back to identifier/#id labels when names are missing", async () => {
      const bare = {
        id: 1,
        summary: "Printer down",
        status: { id: 4 },
        company: { id: 12, identifier: "acme" },
      };
      const card = await buildTicketCard(bare, client);
      expect(card?.status).toBe("#4");
      expect(card?.company).toBe("acme");
      expect(card?.contact).toBeUndefined();
    });

    it("truncates long notes so the card payload stays small", async () => {
      const longNotes = [{ id: 1, text: "x".repeat(600), createdBy: "bot" }];
      const card = await buildTicketCard(ticket, { get: vi.fn(async () => longNotes) });
      expect(card?.notes).toEqual([{ who: "bot", text: "x".repeat(500) }]);
    });

    it("returns null for payloads that are not a ticket", async () => {
      expect(await buildTicketCard({ id: 1 }, client)).toBeNull();
      expect(await buildTicketCard({ summary: "no id" }, client)).toBeNull();
    });

    it("survives note-fetch failures (card is best-effort)", async () => {
      const failing = {
        get: vi.fn(async () => {
          throw new Error("ConnectWise API GET returned 500");
        }),
      };
      const card = await buildTicketCard(ticket, failing);
      expect(card).toMatchObject({ id: 4821, notes: [] });
      expect(card?.status).toBe("New");
    });
  });

  describe("cw_get_ticket end-to-end", () => {
    it("attaches _card to the tool result without touching the ticket payload", async () => {
      const ticket = {
        id: 77,
        summary: "Server offline",
        status: { id: 1, name: "New" },
        company: { id: 2, name: "Acme Corp" },
      };
      // CwManageClient uses global fetch; stub it so no network is touched.
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL) => {
          const href = String(url);
          const data = href.includes("/notes")
            ? [{ id: 1, text: "First note", createdBy: "druiz" }]
            : ticket;
          return new Response(JSON.stringify(data), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );

      const body = (await mcp({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "cw_get_ticket", arguments: { id: 77 } },
      })) as { result?: { content?: { text?: string }[] } };

      const payload = JSON.parse(body.result?.content?.[0]?.text ?? "{}");
      // Model-visible ticket fields are unchanged …
      expect(payload).toMatchObject(ticket);
      // … with the additive normalized card.
      expect(payload._card).toMatchObject({
        id: 77,
        summary: "Server offline",
        status: "New",
        company: "Acme Corp",
        notes: [{ who: "druiz", text: "First note" }],
        noteDefaults: { internalAnalysisFlag: true },
      });
    });

    it("drops the card (not the result) when the notes fetch fails mid-build", async () => {
      const ticket = { id: 78, summary: "Disk full", status: { id: 9 } };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL) => {
          if (String(url).includes("/notes")) {
            return new Response("boom", { status: 500 });
          }
          return new Response(JSON.stringify(ticket), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );

      const body = (await mcp({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "cw_get_ticket", arguments: { id: 78 } },
      })) as { result?: { isError?: boolean; content?: { text?: string }[] } };

      expect(body.result?.isError).toBeFalsy();
      const payload = JSON.parse(body.result?.content?.[0]?.text ?? "{}");
      expect(payload).toMatchObject(ticket);
      // Card still renders (notes degrade to empty), tool result unharmed.
      expect(payload._card).toMatchObject({ id: 78, notes: [] });
    });
  });
});
