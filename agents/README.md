# Konoha Agent Team

Multi-agent system built on Claude Code. Agents communicate via the [Konoha bus](../README.md),
receive tasks through watchdog services, and operate autonomously.

## Team Roster

Canonical lifecycle, ownership, MCP allowlist, resource budget, systemd/tmux,
watchdog, Kiba monitoring, and paused-service policy are defined in
[`docs/system-agent-roster.md`](../docs/system-agent-roster.md). This README is
a short operator-facing index.

| # | Agent | Model | Role | tmux | Status |
|---|-------|-------|------|------|--------|
| 1 | [Naruto](naruto/AGENTS.md) | Sonnet | Telegram bot connector | `naruto` | Connector-owned |
| 2 | [Sasuke](sasuke/AGENTS.md) | Sonnet | Telegram user-account connector | `sasuke` | Connector-owned |
| 3 | [Mirai](mirai/AGENTS.md) | Haiku | External-source connector compatibility actor | `mirai` | Connector-owned on demand |
| 4 | [Jiraiya](jiraiya/AGENTS.md) | Haiku | Deprecated knowledge-curator compatibility alias | `jiraiya` | Deprecated |
| 5 | [Shino](shino/AGENTS.md) | Sonnet | Optional QA lead | `shino` | On demand |
| 6 | [Hinata](hinata/AGENTS.md) | Haiku | Optional QA executor | `hinata` | On demand |
| 7 | [Kiba](kiba/AGENTS.md) | Sonnet | System monitor | `kiba` | Optional, enabled by health policy |
| 8 | [Kakashi](kakashi/AGENTS.md) | gpt-5.5 | Developer — implements fixes, submits to Reviewer | `kakashi` | Optional, enabled by health policy |
| 9 | [Shikadai](shikadai/AGENTS.md) | gpt-5.5 | Reviewer / architecture-code review worker | `shikadai` | Optional, enabled by health policy |
| 10 | [Guy](guy/AGENTS.md) | Haiku | Optional mechanical developer helper | `guy` | On demand |
| 11 | [Ibiki](ibiki/AGENTS.md) | Sonnet | Optional security auditor | `ibiki` | On demand |
| 12 | [Ino](ino/AGENTS.md) | Sonnet | Deprecated marketing-specialist compatibility alias | `ino` | Deprecated |
| 13 | [Inojin](inojin/AGENTS.md) | Haiku | Deprecated editor compatibility alias | `inojin` | Deprecated |
| — | [Itachi](itachi/AGENTS.md) | Sonnet+ | External remote operator on owner's machine | `itachi` | External |
| — | Shikamaru | Opus | External owner advisor compatibility name | — | External |
| — | Akamaru | Python | Autonomous health monitoring script | — | Optional monitor, enabled by health policy |

## Message Delivery Architecture

```
Telegram Bot API ──► message-queue.jsonl ──► watchdog-naruto ──► tmux naruto
Telegram Telethon ──► Redis telegram:incoming ──► watchdog-sasuke ──► tmux sasuke
Konoha SSE ──► dedicated or lifecycle watchdog ──► tmux {agent}
GitHub ready-for-dev Issues ──► watchdog-kakashi ──► tmux kakashi
GitHub ready-for-review Issues ──► watchdog-shikadai ──► tmux shikadai
Akamaru alerts ──► Konoha ──► watchdog-kiba ──► tmux kiba
```

## Konoha Bus

- HTTP API: `http://127.0.0.1:3200` (local), `https://agent.eaprelsky.ru` (external)
- Agents receive messages via SSE: `GET /messages/{id}/stream`
- Agents send messages: `POST /messages` `{"from": "id", "to": "id", "text": "..."}`
- MCP tools: `konoha_send`, `konoha_read`, `konoha_agents`, `konoha_register`

## Shared Storage

| Path | Purpose |
|------|---------|
| `/opt/shared/agent-memory/` | Shared agent memory (38+ files) |
| `/opt/shared/jiraiya/` | Chronicle: media/, internal/, private/ |
| `/opt/shared/shino/` | QA: plans/, reports/, bugs/ |
| `/opt/shared/kiba/` | Monitoring: logs/, reports/ |
| `/opt/shared/attachments/` | Files from Telegram |

## Systemd Services

Canonical unit files live in `/home/ubuntu/konoha/systemd/`.
The retired `agents/systemd/` and `agents/scripts/agent-*-service.sh` paths must not be used.

Permanent agents use two services:
- `agent-{agent}.service` — supervises the agent through the Konoha lifecycle API (`scripts/agent-api-service.sh`)
- `agent-watchdog-{agent}.service` — delivers Telegram/Konoha/GitHub events to the agent's isolated tmux socket

Additionally: `akamaru.service` — autonomous system health monitoring.

On-demand agents are started by `POST /agents/{id}/start` and receive messages through `agent-watchdog-lifecycle.service`.
Kakashi, Shikadai, Kiba, Naruto, and Sasuke use dedicated watchdogs because their delivery filters are role-specific.

## Running Services

| Service | Purpose |
|---------|---------|
| `konoha-testbench` | On-demand bounded Chromium service (port 3203), default Playwright BrowserContext pool 1 / max 2, used by Hinata for GUI testing. systemd: konoha-testbench.service |

Browser/UI checks should use TestBench by default. Direct browser MCP servers
such as Puppeteer are reserved for explicit time-boxed QA/debug sessions; see
[`docs/browser-testing-policy.md`](../docs/browser-testing-policy.md).
Office, Miro, and spreadsheet MCP servers are also optional packs and should not
start in always-on agent sessions; see
[`docs/mcp-optional-packs-policy.md`](../docs/mcp-optional-packs-policy.md).

## Adding a New Agent

1. Create/update the AgentDef via Konoha UI/API: `runtime`, `model`, `capabilities`, optional `shared_mcp_allowlist`, optional `redis_streams`.
2. Put long-lived role instructions in `agents/{name}/AGENTS.md` only if this is a named system agent.
3. For on-demand agents, add the id to `WATCHDOG_AGENTS` in `systemd/agent-watchdog-lifecycle.service`.
4. For permanent agents, instantiate `systemd/agent-managed@.service` or add a dedicated `systemd/agent-{name}.service` wrapper that calls `scripts/agent-api-service.sh`.
5. Add monitoring metadata to `scripts/akamaru.py` (`WATCHED_AGENTS`, `WATCHED_SESSIONS`, `AGENT_WATCHDOGS`) only if Kiba should supervise it.
6. Do not create per-agent startup shell loops; lifecycle owns tmux, prompts, MCP config, restart loop, and runtime selection.
