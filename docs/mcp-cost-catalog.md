# MCP Cost Catalog and Default Allowlists

Issue #766 snapshot: 2026-05-20 20:18 MSK.

Source command:

```bash
ps -eo pid=,ppid=,rss=,pcpu=,comm=,args=
```

The typed source of truth is `src/agent/mcp-cost-catalog.ts`. This document is
the operator-facing summary of the same policy.

## Default Role Allowlists

Every managed runtime gets the Konoha MCP because it is the bus/action surface.
Other MCPs are default only when the agent role owns that connector flow.

| Role | Agents | Default MCP allowlist | Reason |
|------|--------|-----------------------|--------|
| Telegram bot connector | `naruto` | `konoha` | Keeps bot delegation and GitHub coordination intact; Naruto does not need Telethon, Bitrix24, browser, Office, or knowledge MCPs by default. |
| Telegram user connector | `sasuke` | `konoha`, `telethon-channel`, `bitrix24` | Keeps user-account Telegram delivery and CRM routing intact. Yonote is a task/session read-context overlay, not a default. |
| Monitoring-only | `kiba` | `konoha` | Kiba is monitoring-only; no corporate, browser, Office, memory, calendar, audio, or document MCPs by default. |
| SDD developer/reviewer | `kakashi`, `shikadai`, `guy` | `konoha` | SDD work uses local repo tools, `gh`, and Konoha handoff. |
| QA | `shino`, `hinata` | `konoha` | QA defaults use Konoha plus TestBench capability, not direct Puppeteer MCP. |
| External-source connector | `mirai` | `konoha`, `bitrix24` | Connector-owned and on-demand; email uses the adapter runtime, not email MCP. |
| Deprecated compatibility | `jiraiya`, `ino`, `inojin` | `konoha` | Parked by default; if temporarily enabled, regenerate to Konoha-only unless a new issue approves more. |

Connector MCP ownership is explicit. `telethon-channel` is owned by the
Telegram user connector (`sasuke`) only. `bitrix24` is owned by the Telegram
user connector and the on-demand external-source/business-ops path (`mirai` or
the `business-ops` tool profile). Broad non-owner startup profiles skip both
connector MCPs even when shared catalogs define them.

## Cost Catalog

RSS values are idle resident memory for the sampled process set. For MCPs with
wrapper processes, process count and RSS include the wrapper and child. A zero
count means the server was configured in shared catalogs or included in issue
scope but was not resident in the sampled runtime.

| MCP server | Necessity | Default roles | Opt-in | Retired | Idle procs | Idle RSS KiB | CPU % | Measurement note |
|------------|-----------|---------------|--------|---------|------------|--------------|-------|------------------|
| `konoha` | default-critical | all managed agents | no | no | 1 per agent | 80,000 | 0.0 | Orphan cleanup reduced live Konoha MCPs from 35 total/30 orphaned to 5 total/0 orphaned. |
| `telethon-channel` | default-critical | Telegram user connector | no | no | 1 | 89,676 | 0.0 | Required by Sasuke; an extra stale Kiba instance remains until Kiba regeneration. |
| `bitrix24` | role-scoped | Sasuke, Mirai | no | no | 1 | 79,592 | 0.0 | Required where CRM routing is owned by the role; an extra stale Kiba instance remains. |
| `gitlab` | optional-on-demand | none | yes | no | 3 | 109,992 | 0.0 | Observed only under stale Kiba broad MCP config. |
| `yonote` | role-scoped | none | yes | no | 2 | 24,156 | 0.0 | #775 approves bounded Sasuke read/search context only through task/session mode; persistent default delta is 0. |
| `yonote-read` | role-scoped | none | yes | no | 2 | 24,156 | 0.0 | Repo-owned Sasuke read/search-only surface; no raw RPC, write, delete, export, admin, or upload tools. |
| `yandex-tracker` | optional-on-demand | none | yes | no | 0 | 0 | 0.0 | Configured but not resident in the sample. |
| `memory` | optional-on-demand | none | yes | no | 3 | 106,656 | 0.0 | Duplicates Konoha/shared-memory workflows. |
| `mempalace` | retired | none | no | yes | 0 | 0 | 0.0 | Removal candidate; runtime skips stale references. |
| `puppeteer` | optional-on-demand | none | yes | no | 3 | 105,648 | 0.0 | Moved to lazy task/session mode in #767; browser child processes add memory only when the on-demand session is active. |
| `sequential-thinking` | optional-on-demand | none | yes | no | 3 | 101,256 | 0.0 | Analysis helper, not always-on runtime. |
| `caldav` | optional-on-demand | none | yes | no | 2 | 26,744 | 0.0 | Calendar access is not a default responsibility. |
| `google-sheets` | optional-on-demand | none | yes | no | 0 | 0 | 0.0 | Optional-pack gate keeps it out of broad defaults. |
| `google-docs` | optional-on-demand | none | yes | no | 0 | 0 | 0.0 | Optional-pack gate keeps it out of broad defaults. |
| `openrouter-audio` | optional-on-demand | none | yes | no | 2 | 24,104 | 0.0 | Audio transcription is on-demand. |
| `miro` | optional-on-demand | none | yes | no | 0 | 0 | 0.0 | Remote HTTP MCP; no local resident process. |
| `miro-api` | optional-on-demand | none | yes | no | 2 | 24,140 | 0.0 | Collaboration/debug TTL pack. |
| `excel` | optional-on-demand | none | yes | no | 2 | 24,160 | 0.0 | Office/spreadsheet TTL pack. |
| `word` | optional-on-demand | none | yes | no | 0 | 0 | 0.0 | No live process after optional-pack gate; #785 saw 2 procs / 87,256 KiB when stale defaults started it. |
| `email` | optional-on-demand | none | yes | no | 1 | 14,844 | 0.0 | Minimal mail runtime uses `src/adapters/email.ts`, not email MCP. |

## Heavy and Retired Packs

These MCPs must remain opt-in/on-demand unless a future issue assigns a bounded
role responsibility and TTL:

- Heavy local process packs: `gitlab`, `memory`, `puppeteer`, `sequential-thinking`
- Office/collaboration/debug packs: `excel`, `word`, `google-docs`, `google-sheets`, `miro`, `miro-api`
- Other non-default connectors: `yonote`, `yandex-tracker`, `caldav`, `openrouter-audio`, `email`

`puppeteer`, full `yonote`, and Sasuke's narrow `yonote-read` surface are additionally lazy-gated: persistent agent startup
defers them even when a debug/profile overlay allowlists them. A task/session
must request `KONOHA_MCP_SESSION_PACKS=puppeteer` or
`KONOHA_MCP_SESSION_PACKS=yonote-read`, and the stdio process is wrapped with an
idle timeout. For Sasuke, Yonote is a real read/search-only MCP surface; see
`docs/adr-008-sasuke-yonote-read-context.md`.

All shared catalog packs that still launch through `npx -y` or `uvx` are
treated the same way after #782: they are excluded from persistent startup and
can only be attached through the task/session MCP entrypoint with an idle
timeout. This keeps always-on Naruto/Sasuke/Kiba/SDD startup deterministic and
offline-safe.

`mempalace` is retired, not optional. Do not preserve it in active profiles,
generated `.mcp.json` files, or role defaults.

## Duplicate Processes

Before cleanup on 2026-05-20, live runtime had 35 `konoha` MCP Bun processes;
30 had `PPID=1`, meaning their stdio parent had exited. Those orphaned
processes were killed, leaving 5 live Konoha MCPs attached to active Naruto,
Sasuke, Kiba, Kakashi, and Shikadai sessions.

The sampled Kiba session still had a stale broad generated
`/opt/shared/agent-workdirs/kiba/.mcp.json` and active non-monitoring MCP
children: GitLab, Yonote, memory, Puppeteer, sequential-thinking, CalDAV,
OpenRouter audio, Miro API, Bitrix24, Excel, Telethon channel, and email.
Source defaults already pin Kiba to `kiba-monitor-core` / Konoha-only; the
remaining runtime action is to restart or regenerate Kiba's workdir config in a
maintenance window.

Issue #783 live sample before connector-scope gating found two Bitrix MCP
processes and two Telethon MCP processes:

| Set | Process count | RSS KiB |
| --- | ---: | ---: |
| Current live connector MCPs | 4 | 286,364 |
| Expected owner set after non-owner regeneration | 2 | about 143,576 |
| Expected duplicate reduction | 2 | about 142,788 |

The exact split depends on which stale agent owns the second pair. Source
generation now prevents broad non-owner profiles from creating the duplicate
pair again.
