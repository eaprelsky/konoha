# MCP Optional Packs Policy

Issue #785 gates heavy collaboration MCP servers so they do not start in
always-on or monitoring-oriented agent sessions.

## Default Shared MCP Load

When an agent has broad shared MCP access, `buildMcpConfig()` skips these
optional packs unless they are explicitly allowlisted by a time-boxed profile:

- `excel`
- `word`
- `google-docs`
- `google-sheets`
- `miro`
- `miro-api`
- `puppeteer`

Each skipped pack is logged as `skipping optional shared MCP pack` with the
server name and source config path. An explicit `shared_mcp_allowlist` or
time-boxed `tool_profile` can still include one of these servers for an
on-demand session.

## Allowed On-Demand Profiles

- `browser-debug-ttl`: direct Puppeteer MCP for explicit QA/debug sessions.
- `office-miro-debug-ttl`: Office, Miro, Google Docs, and Google Sheets MCPs for
  explicit document/spreadsheet/whiteboard debug sessions.

Do not assign these profiles to Naruto, Sasuke, Kiba, Kakashi, Shikadai, or
other always-on/default operational agents.

## Default GUI Path

Browser/UI checks use bounded TestBench by default. See
`docs/browser-testing-policy.md`.
