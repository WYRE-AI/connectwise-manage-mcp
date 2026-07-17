## [Unreleased]

### Added

- **Interactive ticket card via MCP Apps (SEP-1865).** `cw_get_ticket` results now render as an interactive card in MCP Apps hosts (Claude Desktop/web, and other hosts advertising the `io.modelcontextprotocol/ui` extension), instead of a wall of JSON. The card shows status, priority, company, contact, owner, and board as human-readable labels, key dates, and recent notes — and includes a working "Add note" round-trip that calls `cw_add_ticket_note` from inside the card, defaulting to an internal-only (`internalAnalysisFlag`) note resolved server-side. Non-App hosts are unaffected: the tool's JSON payload is unchanged apart from a new `_card` field.
  - The two renderable tools advertise the UI via `_meta` (`ui/resourceUri`, plus the nested `ui.resourceUri` form) pointing at a new `ui://connectwise-manage/ticket-card.html` resource served as `text/html;profile=mcp-app`. The card HTML is a self-contained vite single-file bundle embedded at build time (`src/generated/ticket-card-html.ts`, committed), so it serves identically from stdio, Node HTTP, and the fs-less Cloudflare Workers runtime. The server now declares the `resources` capability and answers `resources/list` / `resources/read` (`src/resources.ts`).
  - The card is neutral by default (system fonts, no vendor identity, no external fetches) and brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`): at serve time the server replaces the card's BRAND_INJECT marker with an inline, `<`-escaped `window.__BRAND__` script, so self-hosters can theme the card without rebuilding. No brand configured = HTML served unchanged.

### Changed

- Publish the package to the GitHub Packages npm registry (`npm.pkg.github.com`) on release: `@semantic-release/npm` `npmPublish` enabled and `publishConfig.registry` set.

### Documentation

- Clarify the "Deploy to Cloudflare Workers" / "Deploy to DigitalOcean" one-click flow: this server depends only on public npm packages, so the cloud builders install without any registry token. Installing the published package from GitHub Packages does require a GitHub PAT with `read:packages` (`export NODE_AUTH_TOKEN=$(gh auth token)`).

# [1.4.0](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.3.0...v1.4.0) (2026-04-03)


### Features

* add finance agreements and sales opportunities tools ([886083f](https://github.com/wyre-technology/connectwise-manage-mcp/commit/886083f808e7034756703be04cf810e549e81894))

# [1.3.0](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.2.1...v1.3.0) (2026-04-01)


### Bug Fixes

* resolve TypeScript errors in middleware tests for jose v6 ([f2fbf77](https://github.com/wyre-technology/connectwise-manage-mcp/commit/f2fbf77c29de332ed5d803f0d88b301a810c7624))


### Features

* add Entra ID OAuth 2.1 authentication layer ([ee9563d](https://github.com/wyre-technology/connectwise-manage-mcp/commit/ee9563d914a32ccb3304dfa2eb8d4d18eb8d8b8f))
* add ticket and project ticket notes tools ([9573d08](https://github.com/wyre-technology/connectwise-manage-mcp/commit/9573d087009a62fb51bc9616eaf690fa92e10026))

## [1.2.1](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.2.0...v1.2.1) (2026-03-31)


### Bug Fixes

* **deploy:** replace node_compat with nodejs_compat for Wrangler v4 ([659fd01](https://github.com/wyre-technology/connectwise-manage-mcp/commit/659fd01b694baa081319430ca4dc810bfda5dca0))

## [1.1.5](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.1.4...v1.1.5) (2026-03-02)


### Bug Fixes

* **ci:** fix broken YAML in Discord notification step ([f8412f1](https://github.com/wyre-technology/connectwise-manage-mcp/commit/f8412f1869c97929e0c218ab84cd78714ab5dfcb))
* **ci:** move Discord notification into release workflow ([9b439d0](https://github.com/wyre-technology/connectwise-manage-mcp/commit/9b439d01a3addb01d6a2e9c7c254fbfa91c597a3))

## [1.1.4](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.1.3...v1.1.4) (2026-02-23)


### Bug Fixes

* quote MCPB bundle filename in release upload step and add debug listing ([50fe9ea](https://github.com/wyre-technology/connectwise-manage-mcp/commit/50fe9ea8b46b5cac308714544fc26fd39b0a3f4e))

## [1.1.3](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.1.2...v1.1.3) (2026-02-18)


### Bug Fixes

* strip npm scope from MCPB bundle filename ([dd178af](https://github.com/wyre-technology/connectwise-manage-mcp/commit/dd178af6caabd7d3c231f362426244c9722264b4))

## [1.1.2](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.1.1...v1.1.2) (2026-02-18)


### Bug Fixes

* convert pack-mcpb.js to ESM imports ([73733cb](https://github.com/wyre-technology/connectwise-manage-mcp/commit/73733cb73fbb53816aab6685b86fa532573a7019))

## [1.1.1](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.1.0...v1.1.1) (2026-02-18)


### Bug Fixes

* **ci:** fix release workflow failures ([1f18198](https://github.com/wyre-technology/connectwise-manage-mcp/commit/1f18198616ab53a2a7adf6b4f7196071473504f4))

# [1.1.0](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.0.1...v1.1.0) (2026-02-18)


### Features

* add MCPB bundle to release workflow ([a1107a2](https://github.com/wyre-technology/connectwise-manage-mcp/commit/a1107a2e52b2803d06d13b044f010e067e482949))
* add MCPB manifest for desktop installation ([05b49f5](https://github.com/wyre-technology/connectwise-manage-mcp/commit/05b49f5aed4d9cab02fa3f9954a33a9c47ebeb4a))
* add MCPB pack script ([2abb833](https://github.com/wyre-technology/connectwise-manage-mcp/commit/2abb83319dc932eed4a5f6f44272038781a74d2b))

# [1.1.0](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.0.1...v1.1.0) (2026-02-17)


### Features

* add MCPB bundle to release workflow ([a1107a2](https://github.com/wyre-technology/connectwise-manage-mcp/commit/a1107a2e52b2803d06d13b044f010e067e482949))
* add MCPB manifest for desktop installation ([05b49f5](https://github.com/wyre-technology/connectwise-manage-mcp/commit/05b49f5aed4d9cab02fa3f9954a33a9c47ebeb4a))
* add MCPB pack script ([2abb833](https://github.com/wyre-technology/connectwise-manage-mcp/commit/2abb83319dc932eed4a5f6f44272038781a74d2b))

## [1.0.1](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.0.0...v1.0.1) (2026-02-17)


### Bug Fixes

* **docker:** drop arm64 platform to fix QEMU build failures ([2c01732](https://github.com/wyre-technology/connectwise-manage-mcp/commit/2c01732ed3f4defc024dcddd95fba283ab92048c))

# 1.0.0 (2026-02-17)


### Bug Fixes

* add package-lock.json for npm ci in CI and Docker builds ([0fd9271](https://github.com/wyre-technology/connectwise-manage-mcp/commit/0fd927144f0261fd3d878d83d0c29646dd38c4ef))
* **ci:** fix duplicate step IDs, use Node 22 for semantic-release, drop Node 18 ([9aa7f4c](https://github.com/wyre-technology/connectwise-manage-mcp/commit/9aa7f4cc0c37bab59abf3a3a33776264be870acc))
* **ci:** remove npm cache (no package-lock.json in repo) ([d2e1c37](https://github.com/wyre-technology/connectwise-manage-mcp/commit/d2e1c3747728fbd1433f7eedb098b1c265606911))
* **deps:** add semantic-release and plugin devDependencies ([ad815b3](https://github.com/wyre-technology/connectwise-manage-mcp/commit/ad815b31fb312ab71feaa9c0236e2ba4e20e8834))
* escape newlines in .releaserc.json message template ([bc32d79](https://github.com/wyre-technology/connectwise-manage-mcp/commit/bc32d79115d5d1df84a785bd59c1b33ed38cb6a6))
* pass with no tests and add semantic-release devDependencies ([b8653f0](https://github.com/wyre-technology/connectwise-manage-mcp/commit/b8653f01b01ff2fe041aa9016e2980bf16b66a0a))
* regenerate package-lock.json with semantic-release deps ([92e5903](https://github.com/wyre-technology/connectwise-manage-mcp/commit/92e5903cbabc889467beb5090b7957d33b8b522b))
* regenerate package-lock.json with semantic-release deps ([5c54789](https://github.com/wyre-technology/connectwise-manage-mcp/commit/5c547897e8125d8d25c105b701006fff755bc7db))


### Features

* add mcpb packaging support ([50a58ac](https://github.com/wyre-technology/connectwise-manage-mcp/commit/50a58acdaee22db656cf4910223ad1a09e985067))
* add mcpb packaging support ([c14db0d](https://github.com/wyre-technology/connectwise-manage-mcp/commit/c14db0d92b7af5e1d9728e648e66d5900b18f0c8))
* add mcpb packaging support ([258863b](https://github.com/wyre-technology/connectwise-manage-mcp/commit/258863b365583d065cf1dfee0cad625fb036309f))
* add mcpb packaging support ([693b11c](https://github.com/wyre-technology/connectwise-manage-mcp/commit/693b11ccf95cdd4ab1262245728a4d525908706f))
* add mcpb packaging support ([71026b8](https://github.com/wyre-technology/connectwise-manage-mcp/commit/71026b815135b468cc0e912c52beba51ec0659c6))
* scaffold ConnectWise Manage MCP server with deploy infrastructure ([72b18a2](https://github.com/wyre-technology/connectwise-manage-mcp/commit/72b18a210605b5c74946d8df202ec2fae93dafd2))
