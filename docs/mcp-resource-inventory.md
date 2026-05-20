# MCP Resource Inventory

Snapshot for issue #785 on 2026-05-16, before deploying the optional-pack gate.

For the issue #766 per-server cost catalog and default role allowlists, see
[`docs/mcp-cost-catalog.md`](mcp-cost-catalog.md).

## Live Optional MCP Processes Before #785

Command:

```bash
ps -eo pid=,rss=,args= | awk 'BEGIN{IGNORECASE=1} /mcp-google-sheets|google-docs-mcp|office-word-mcp-server|word_mcp_server|excel-mcp-server|miro-api-mcp|mcp\\.miro\\.com|server-puppeteer|puppeteer/ && !/awk/ {print}'
```

| Pack | Process count | RSS KiB | Notes |
|------|---------------|---------|-------|
| `miro-api` | 2 | 65,392 | `uv --directory .../miro-api-mcp run main.py`, Python worker |
| `excel` | 2 | 76,700 | `uvx excel-mcp-server stdio`, Python worker |
| `word` | 2 | 87,256 | `uvx --from office-word-mcp-server word_mcp_server`, Python worker |
| `puppeteer` | 3 | 148,652 | Existing #778 browser MCP cleanup target still present in stale generated runtime config |
| `google-sheets` | 0 | 0 | Not running in the sampled process table |
| `google-docs` | 0 | 0 | Not running in the sampled process table |
| **Office/Miro/spreadsheet subtotal** | **6** | **229,348** | Target scope for #785 |
| **All optional gated packs subtotal** | **9** | **378,000** | Includes Puppeteer, already covered by #778 |

Live generated configs also showed stale broad shared MCP access in Kiba and
Mirai workdirs. Kiba's generated `.mcp.json` included `excel`, `word`,
`google-docs`, `google-sheets`, `miro`, `miro-api`, and `puppeteer`.

## Expected After #785

Source-level verification command after the #785 change:

```bash
bun -e 'import { buildMcpConfig } from "./src/agent/runtime"; const cfg = await buildMcpConfig([], {}, undefined); console.log(Object.keys(cfg.mcpServers).sort().join(","));'
```

The command logged `skipping optional shared MCP pack` for `puppeteer`,
`google-sheets`, `miro`, `miro-api`, `excel`, `word`, and `google-docs`.
Before #774, the generated broad shared MCP key set still included the retired
MemPalace server:

```text
bitrix24,caldav,email,filesystem,gitlab,konoha,memory,mempalace,openrouter-audio,sequential-thinking,telegram,telethon-channel,yandex-tracker,yonote
```

After #774, `mempalace` is no longer part of active runtime generation. It is
skipped even when a stale shared config or explicit allowlist mentions it.

After affected agents restart and their `.mcp.json` files are regenerated:

| Pack set | Expected default process count | Expected default RSS KiB |
|----------|-------------------------------|--------------------------|
| Office/Miro/spreadsheet packs | 0 | 0 |
| Direct browser MCP | 0 | 0 |

The shared catalog can still contain these server definitions for explicit
on-demand sessions. Startup profiles skip them by default and log each skipped
optional pack.

## Sasuke Yonote Context Decision After #775

Yonote is not added to Sasuke persistent startup. The approved path is a
task/session read-context overlay gated by `corporate-memory` and
`KONOHA_MCP_SESSION_PACKS=yonote`; see
`docs/adr-008-sasuke-yonote-read-context.md` and
`docs/sasuke-yonote-context-policy.json`.

Live sample on 2026-05-20 22:53 MSK still found Yonote under stale Kiba broad
MCP config:

| Owner | Process count | RSS KiB | Notes |
| --- | ---: | ---: | --- |
| Stale Kiba Yonote MCP | 2 | 24,156 | `uv --directory .../yonote-mcp run main.py` plus Python child |
| Sasuke persistent default delta | 0 | 0 | Default remains `konoha`, `telethon-channel`, `bitrix24` |
| Sasuke task/session overlay delta | 2 | 24,156 | Only while the bounded session requests `yonote` |

If Yonote is disabled or unavailable, Sasuke must continue user-account
listening and CRM routing without Yonote context.

## Kiba MCP Surface Before #762

Snapshot on 2026-05-16 before applying the `kiba-monitor-core` profile. The
running Kiba service still used a stale generated
`/opt/shared/agent-workdirs/kiba/.mcp.json` with broad corporate MCP access.

Command:

```bash
pstree -p 711418
```

Observed non-monitoring MCPs under the Kiba Claude process included GitLab,
Yonote, memory, Puppeteer, CalDAV, sequential-thinking, openrouter-audio,
Miro API, Bitrix24, Excel, Word, Telethon channel, email, and the now-retired
MemPalace server.

Process/RSS summary:

| Kiba child process set | Process count | RSS KiB | Notes |
|------------------------|---------------|---------|-------|
| All MCP descendants under running Kiba | 29 | 1,433,224 | Includes stale broad MCP startup plus one Konoha MCP server |
| Expected `kiba-monitor-core` default | 1 | about 86,900 | Konoha MCP server only, based on the live Konoha MCP child RSS in the same sample |
| Expected non-monitoring MCPs after Kiba restart/regeneration | 0 | 0 | GitLab/Yonote/Yandex/Miro/Office/browser/memory/calendar/audio/corporate ops are not in Kiba default profile |

The running process tree remains stale until Kiba is restarted or the affected
agent workdir `.mcp.json` is regenerated. The source-of-truth default now uses
`kiba-monitor-core`, which resolves to the Konoha MCP server only.

## Jiraiya Corporate-Memory Experiment After #763

Jiraiya is disabled until a concrete product need is approved. Its seeded
definition now uses the default Konoha-only tool profile, and
`agent-watchdog-lifecycle.service` no longer lists `jiraiya` in
`WATCHDOG_AGENTS`. `watchdog-lifecycle.py` also rejects `jiraiya` from explicit
argv or `WATCHDOG_AGENTS` delivery unless an approved rollback sets
`KONOHA_ENABLE_DISABLED_EXPERIMENT_AGENTS=jiraiya`.

The stale active workdir MCP config was quarantined on 2026-05-16:

```text
/opt/shared/agent-workdirs/.quarantine/jiraiya/issue-763-20260516T1814/.mcp.json
```

That quarantined config had broad corporate/debug MCP entries, including
Yonote, memory, the retired MemPalace server, Office/Miro/spreadsheet, browser,
calendar, audio, GitLab, Bitrix24, email, and Telethon channel servers. It must
not be copied back into the active workdir. Reactivation must regenerate a
fresh `.mcp.json` from the approved profile or allowlist, and MemPalace must not
be restored without a new product requirement and issue.
