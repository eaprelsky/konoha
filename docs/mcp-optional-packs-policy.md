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

`mempalace` is different: it is retired, not optional. `buildMcpConfig()` skips
it even when a stale shared config or explicit allowlist still mentions it, and
logs `skipping retired shared MCP pack`. Do not add MemPalace back to active
agent profiles without a new product requirement and a new issue.

## Bounded and On-Demand Profiles

- `kiba-monitor-core`: Kiba default profile; Konoha health/action tools only.
- `browser-debug-ttl`: direct Puppeteer MCP for explicit QA/debug sessions.
- `office-miro-debug-ttl`: Office, Miro, Google Docs, and Google Sheets MCPs for
  explicit document/spreadsheet/whiteboard debug sessions.

Do not assign the `browser-debug-ttl` or `office-miro-debug-ttl` profiles to
Naruto, Sasuke, Kiba, Kakashi, Shikadai, or other always-on/default operational
agents.

`kiba-monitor-core` is the exception because it is the bounded default profile,
not an on-demand expansion. Kiba must not carry GitLab, Yonote, Yandex Tracker,
Miro, Office/document tools, browser/Puppeteer, memory, retired MemPalace,
spreadsheets, calendar, audio/transcription, or broad corporate operations MCPs
by default.

## Default GUI Path

Browser/UI checks use bounded TestBench by default. See
`docs/browser-testing-policy.md`.
