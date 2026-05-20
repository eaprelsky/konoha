# MCP Optional Packs Policy

Issue #785 gates heavy collaboration MCP servers so they do not start in
always-on or monitoring-oriented agent sessions.

The cost catalog and default per-role allowlists are maintained in
[`docs/mcp-cost-catalog.md`](mcp-cost-catalog.md) and
`src/agent/mcp-cost-catalog.ts`.

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
time-boxed `tool_profile` can still request one of these servers, but packs
marked on-demand are not attached to persistent startup configs.

## Lazy / On-Demand Packs

`puppeteer` is the first heavy pack moved to lazy mode. Even when
`browser-debug-ttl` or an explicit allowlist requests it, persistent agent
startup defers the pack and records the decision in
`/opt/shared/agent-workdirs/<agent>/mcp-pack-receipt.json`.

To attach the pack for a bounded task/session, build the task MCP config through
the public task-mode entrypoint:

```bash
KONOHA_ENABLED_FEATURES=direct-browser-mcp \
KONOHA_FEATURE_ENABLE_REASON="time-boxed browser debug" \
KONOHA_MCP_SESSION_PACKS=puppeteer \
bun scripts/build-mcp-session-config.ts \
  --allowlist puppeteer \
  --config-out /tmp/konoha-task.mcp.json \
  --receipt-out /tmp/konoha-task.mcp-receipt.json
```

`scripts/build-mcp-session-config.ts` always uses `mode=task`; persistent
`startAgent()` startup continues to use `mode=startup`. The task/session config wraps the stdio MCP server with
`scripts/mcp-idle-wrapper.ts`, which exits after
`KONOHA_MCP_ON_DEMAND_IDLE_TIMEOUT_SEC` seconds of stdin inactivity. The
default timeout is 900 seconds.

Receipts include:

- `included_packs`: on-demand packs attached for the current task/session.
- `deferred_packs`: on-demand packs intentionally omitted from persistent
  startup, with estimated idle RSS saved from the cost catalog.
- `skipped_packs`: packs omitted because they are not allowlisted or their
  feature flag is disabled.

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
