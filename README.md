# ConnectWise Manage MCP Server

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)

**Let your AI assistant work directly with ConnectWise Manage.** Search tickets, log time, look up companies and contacts, manage projects — through natural conversation instead of clicking through the CWM interface.

This is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives Claude (or any MCP-compatible AI) 51 tools covering the daily operations ConnectWise Manage shops depend on. Works with both **cloud-hosted and self-hosted** CWM instances — just point it at your server.

> **Part of the [MSP Claude Plugins](https://github.com/wyre-technology/msp-claude-plugins) ecosystem** — a growing suite of AI integrations for the MSP stack including [Autotask](https://github.com/wyre-technology/autotask-mcp), [Datto RMM](https://github.com/wyre-technology/datto-rmm-mcp), [IT Glue](https://github.com/wyre-technology/itglue-mcp), [HaloPSA](https://github.com/wyre-technology/halopsa-mcp), [NinjaOne](https://github.com/wyre-technology/ninjaone-mcp), [Huntress](https://github.com/wyre-technology/huntress-mcp), and more. Built by MSPs, for MSPs.

## One-Click Deployment

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/wyre-technology/connectwise-manage-mcp/tree/main)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wyre-technology/connectwise-manage-mcp)

> **Note on registry auth:** This server depends only on public npm packages, so the Cloudflare and DigitalOcean cloud builders install its dependencies anonymously — no token is required for one-click deploy. (If a future release adds a private `@wyre-technology/*` dependency, you would supply a GitHub PAT with `read:packages` as a build variable — `NODE_AUTH_TOKEN` for Cloudflare Workers, a build-time `GITHUB_TOKEN` secret for DigitalOcean.)
>
> **Installing the published package:** The released package is published to the [GitHub Packages](https://github.com/wyre-technology/connectwise-manage-mcp/pkgs/npm/connectwise-manage-mcp) npm registry, which requires authentication on every install (even for public packages). To install it, authenticate npm to `npm.pkg.github.com` with a GitHub PAT that has `read:packages`:
>
> ```bash
> export NODE_AUTH_TOKEN=$(gh auth token)
> npm install @wyre-technology/connectwise-manage-mcp
> ```

For deploying to **Azure Container Apps** with Entra ID OAuth 2.1, see [AZURE_ACA_DEPLOYMENT.md](AZURE_ACA_DEPLOYMENT.md).

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CW_MANAGE_COMPANY_ID` | Yes | Your ConnectWise company identifier |
| `CW_MANAGE_PUBLIC_KEY` | Yes | API member public key |
| `CW_MANAGE_PRIVATE_KEY` | Yes | API member private key |
| `CW_MANAGE_CLIENT_ID` | Yes | Client ID from [ConnectWise Developer Portal](https://developer.connectwise.com/) |
| `CW_MANAGE_URL` | No | API base URL (see below) |
| `CW_MANAGE_REJECT_UNAUTHORIZED` | No | Set to `false` for self-signed certs (default: `true`) |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `MCP_HTTP_PORT` | No | HTTP port (default: `8080`) |
| `AUTH_MODE` | No | `env` (default) or `gateway` for header-based auth |

### API Base URL (`CW_MANAGE_URL`)

| Instance Type | URL |
|---------------|-----|
| Cloud (North America) | `https://api-na.myconnectwise.net` (default) |
| Cloud (Europe) | `https://api-eu.myconnectwise.net` |
| Cloud (Australia) | `https://api-au.myconnectwise.net` |
| **Self-hosted** | `https://cwm.yourcompany.com` |

For self-hosted instances, set `CW_MANAGE_URL` to your server's base URL. The server automatically appends `/v4_6_release/apis/3.0` unless the URL already contains that path.

If your self-hosted instance uses a self-signed certificate, also set `CW_MANAGE_REJECT_UNAUTHORIZED=false`.

### Getting Your API Keys

1. Log in to your ConnectWise Manage instance
2. Navigate to **System > Members > API Members**
3. Create a new API member with appropriate permissions
4. Generate API keys for the member
5. Get your Client ID from the [ConnectWise Developer Portal](https://developer.connectwise.com/)

## Available Tools

### Tickets
- `cw_search_tickets` — Search service tickets with conditions
- `cw_get_ticket` — Get a ticket by ID
- `cw_create_ticket` — Create a new service ticket
- `cw_update_ticket` — Update a ticket (JSON Patch)
- `cw_get_ticket_notes` — Get all notes on a ticket (including child ticket notes)
- `cw_add_ticket_note` — Add a note to a ticket (discussion, internal, or resolution)

### Companies
- `cw_search_companies` — Search companies
- `cw_get_company` — Get a company by ID
- `cw_create_company` — Create a new company
- `cw_update_company` — Update a company (JSON Patch)

### Contacts
- `cw_search_contacts` — Search contacts
- `cw_get_contact` — Get a contact by ID
- `cw_create_contact` — Create a new contact

### Projects
- `cw_search_projects` — Search projects
- `cw_get_project` — Get a project by ID
- `cw_create_project` — Create a new project
- `cw_search_project_tickets` — Search tickets under a project
- `cw_get_project_ticket` — Get a specific project ticket by ID
- `cw_get_project_ticket_notes` — Get all notes on a project ticket (including child ticket notes)
- `cw_add_project_ticket_note` — Add a note to a project ticket (discussion, internal, or resolution)

### Time Entries
- `cw_search_time_entries` — Search time entries
- `cw_get_time_entry` — Get a time entry by ID
- `cw_create_time_entry` — Create a new time entry

### Members
- `cw_search_members` — Search members/technicians
- `cw_get_member` — Get a member by ID

### Configuration Items
- `cw_search_configurations` — Search configuration items (assets)
- `cw_get_configuration` — Get a configuration item by ID

### Service Reference Data
- `cw_list_boards` — List service boards
- `cw_list_priorities` — List ticket priorities
- `cw_list_statuses` — List statuses for a board

### Activities
- `cw_search_activities` — Search activities
- `cw_get_activity` — Get an activity by ID
- `cw_create_activity` — Create a new activity

### Agreements
- `cw_search_agreements` — Search agreements
- `cw_get_agreement` — Get an agreement by ID
- `cw_get_agreement_additions` — Get additions (line items) on an agreement

### Invoices
- `cw_search_invoices` — Search invoices
- `cw_get_invoice` — Get an invoice by ID

### Opportunities
- `cw_search_opportunities` — Search opportunities
- `cw_get_opportunity` — Get an opportunity by ID
- `cw_search_opportunity_forecasts` — Search opportunity forecast lines
- `cw_search_opportunity_notes` — Search notes on an opportunity
- `cw_search_sales_stages` — List sales pipeline stages

### Catalog (Products)
- `cw_search_catalog_items` — Search product catalog items
- `cw_get_catalog_item` — Get a catalog item by ID
- `cw_create_catalog_item` — Create a new catalog item
- `cw_update_catalog_item` — Update a catalog item (JSON Patch)
- `cw_list_catalog_categories` — List catalog categories
- `cw_list_catalog_subcategories` — List catalog subcategories
- `cw_list_manufacturers` — List manufacturers

### Health
- `cw_test_connection` — Test connection (hits `/system/info`)

## Usage

### With Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "connectwise-manage": {
      "command": "npx",
      "args": ["@wyre-technology/connectwise-manage-mcp"],
      "env": {
        "CW_MANAGE_COMPANY_ID": "your-company-id",
        "CW_MANAGE_PUBLIC_KEY": "your-public-key",
        "CW_MANAGE_PRIVATE_KEY": "your-private-key",
        "CW_MANAGE_CLIENT_ID": "your-client-id"
      }
    }
  }
}
```

For a self-hosted instance:

```json
{
  "mcpServers": {
    "connectwise-manage": {
      "command": "npx",
      "args": ["@wyre-technology/connectwise-manage-mcp"],
      "env": {
        "CW_MANAGE_URL": "https://cwm.yourcompany.com",
        "CW_MANAGE_COMPANY_ID": "your-company-id",
        "CW_MANAGE_PUBLIC_KEY": "your-public-key",
        "CW_MANAGE_PRIVATE_KEY": "your-private-key",
        "CW_MANAGE_CLIENT_ID": "your-client-id",
        "CW_MANAGE_REJECT_UNAUTHORIZED": "false"
      }
    }
  }
}
```

### With Docker

```bash
docker compose up -d
```

### HTTP Transport (Gateway Mode)

Run with HTTP transport for multi-tenant gateway deployments:

```bash
MCP_TRANSPORT=http AUTH_MODE=gateway node dist/index.js
```

Pass credentials per-request via headers: `X-CW-Company-Id`, `X-CW-Public-Key`, `X-CW-Private-Key`, `X-CW-Client-Id`, and optionally `X-CW-URL`.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development
npm run dev

# Type check
npm run typecheck

# Run tests
npm test
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

Apache-2.0

---

Built by [WYRE Technology](https://github.com/wyre-technology) — part of the [MSP Claude Plugins](https://github.com/wyre-technology/msp-claude-plugins) ecosystem
