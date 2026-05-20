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

`puppeteer` was the first heavy pack moved to lazy mode. Issue #782 extends the
same startup policy to every shared MCP pack that still uses `npx -y` or `uvx`
in the shared catalog. Even when a time-boxed profile or explicit allowlist
requests one of these packs, persistent agent startup defers the pack and
records the decision in `/opt/shared/agent-workdirs/<agent>/mcp-pack-receipt.json`.

Inventory:

| Pack | Catalog launcher | Runtime policy |
| --- | --- | --- |
| `gitlab` | `npx -y @zereight/mcp-gitlab` | task/session on-demand |
| `filesystem` | `npx -y @modelcontextprotocol/server-filesystem` | task/session on-demand |
| `memory` | `npx -y @modelcontextprotocol/server-memory` | task/session on-demand behind `corporate-memory` |
| `puppeteer` | `npx -y @modelcontextprotocol/server-puppeteer` | task/session on-demand behind `direct-browser-mcp` |
| `sequential-thinking` | `npx -y @modelcontextprotocol/server-sequential-thinking` | task/session on-demand |
| `google-sheets` | `uvx mcp-google-sheets@latest` | task/session on-demand behind `office-miro-mcp` |
| `excel` | `uvx excel-mcp-server stdio` | task/session on-demand behind `office-miro-mcp` |
| `word` | `uvx --from office-word-mcp-server word_mcp_server` | task/session on-demand behind `office-miro-mcp` |
| `google-docs` | `npx -y google-docs-mcp` | task/session on-demand behind `office-miro-mcp` |

Always-on required flows do not use `npx` or `uvx`: Naruto uses Konoha MCP
only, and Sasuke uses Konoha plus pinned local `telethon-channel` and local
Bitrix24 MCP commands.

Connector MCPs have owner gates separate from lazy-pack gates:
`telethon-channel` is only included through an explicit Telegram user connector
allowlist, and `bitrix24` is only included through an explicit CRM/sales owner
allowlist such as Sasuke, Mirai, or the `business-ops` tool profile. Broad
non-owner startup skips both connector MCPs to avoid duplicate chat/CRM side
effects.

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

## Cache Cleanup After Conversion

After agents are regenerated and no stale task sessions need the old launcher
caches, clean package-runner caches during a maintenance window:

```bash
rm -rf ~/.npm/_npx ~/.cache/uv/archive-v0 ~/.cache/uv/sdists-v9 ~/.cache/uv/wheels-v5
```

Do not delete shared local MCP source directories under
`/opt/shared/comind-template/mcp/`; required local installs such as Bitrix24 and
Telethon depend on those paths.

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
