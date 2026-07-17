/**
 * MCP resource registration for the ConnectWise Manage MCP server.
 *
 * Exposes the MCP Apps (SEP-1865) ticket-card UI via resources/list and
 * resources/read. The card HTML is embedded at build time
 * (src/generated/ticket-card-html.ts) so it serves identically from stdio,
 * Node HTTP, and the fs-less Cloudflare Workers runtime.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  TICKET_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
  applyBrandInjection,
  resolveBrandFromEnv,
} from "./card.builder.js";
import { TICKET_CARD_HTML } from "./generated/ticket-card-html.js";

export function registerCardResources(server: McpServer): void {
  server.registerResource(
    "ConnectWise Manage Ticket Card",
    TICKET_CARD_RESOURCE_URI,
    {
      description: "Interactive MCP Apps card rendering a ConnectWise Manage service ticket",
      mimeType: MCP_APP_RESOURCE_MIME,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MCP_APP_RESOURCE_MIME,
          // Neutral by default; MCP_BRAND_* env vars inject a per-operator
          // brand at serve time (no rebuild needed). Empty brand = HTML
          // served byte-identical.
          text: applyBrandInjection(TICKET_CARD_HTML, resolveBrandFromEnv()),
        },
      ],
    }),
  );
}
