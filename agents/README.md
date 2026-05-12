# Konoha Agent Team

Multi-agent system built on Claude Code. Agents communicate via the [Konoha bus](../README.md),
receive tasks through watchdog services, and operate autonomously.

## Team Roster

| # | Agent | Model | Role | tmux | Status |
|---|-------|-------|------|------|--------|
| 1 | [Naruto](naruto/AGENTS.md) | Sonnet | Main orchestrator, Telegram bot | `naruto` | Permanent |
| 2 | [Sasuke](sasuke/AGENTS.md) | Sonnet | Telegram user account monitor | `sasuke` | Permanent |
| 3 | [Mirai](mirai/AGENTS.md) | Haiku | Email and data processing | `mirai` | Permanent |
| 4 | [Jiraiya](jiraiya/AGENTS.md) | Sonnet | Chronicler — classifies and archives events | `jiraiya` | Permanent |
| 5 | [Shino](shino/AGENTS.md) | Sonnet | QA Lead — test plans, testing coordination | `shino` | On-demand |
| 6 | [Hinata](hinata/AGENTS.md) | Haiku | QA Runner — runs tests, writes reports | `hinata` | On-demand |
| 7 | [Kiba](kiba/AGENTS.md) | Sonnet | System guardian — monitoring, alerts | `kiba` | Permanent |
| 8 | [Kakashi](kakashi/AGENTS.md) | Opus | Developer — implements fixes, submits to Reviewer | `kakashi` | Permanent |
| 10 | [Guy](guy/AGENTS.md) | Haiku | Optional helper — docs/mechanical only, on explicit request | `guy` | On-demand |
| 9 | [Shikadai](shikadai/AGENTS.md) | gpt-5.5 | Reviewer — reviews architecture, approves before closure | `shikadai` | On-demand |
| 11 | [Ibiki](ibiki/AGENTS.md) | Sonnet | Security pentester — audits Konoha infrastructure | `ibiki` | On-demand |
| 12 | [Ino](ino/AGENTS.md) | Sonnet | Nocturna marketing strategist — content, SEO/AIO, copywriting | `ino` | On-demand |
| 13 | [Inojin](inojin/AGENTS.md) | Haiku | Ino's assistant — API calls, bulk generation, formatting | `inojin` | On-demand |
| — | [Itachi](itachi/AGENTS.md) | Sonnet+ | Local WSL agent (on owner's machine) | `itachi` | Optional |
| — | Shikamaru | Opus | Owner's advisor (Windows Claude Desktop, no tools) | — | External |
| — | Akamaru | Python | Autonomous health monitoring (not Claude, a script) | — | Permanent |

## Message Delivery Architecture

```
Telegram Bot API ──► message-queue.jsonl ──► watchdog-naruto ──► tmux naruto
Telegram Telethon ──► Redis telegram:incoming ──► watchdog-sasuke ──► tmux sasuke
Konoha SSE ──► watchdog-{agent} ──► tmux {agent}
GitHub Issues ──► watchdog-kakashi ──► tmux kakashi
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

## Running Services

| Service | Purpose |
|---------|---------|
| `konoha-testbench` | Persistent Chromium service (port 3203), Playwright BrowserContext pool (3 sessions), used by Hinata for GUI testing. systemd: konoha-testbench.service |

## Adding a New Agent

1. Create/update the AgentDef via Konoha UI/API: `runtime`, `model`, `capabilities`, optional `shared_mcp_allowlist`, optional `redis_streams`.
2. Put long-lived role instructions in `agents/{name}/AGENTS.md` only if this is a named system agent.
3. For on-demand agents, add the id to `WATCHDOG_AGENTS` in `systemd/agent-watchdog-lifecycle.service`.
4. For permanent agents, instantiate `systemd/agent-managed@.service` or add a dedicated `systemd/agent-{name}.service` wrapper that calls `scripts/agent-api-service.sh`.
5. Add monitoring metadata to `scripts/akamaru.py` (`WATCHED_AGENTS`, `WATCHED_SESSIONS`, `AGENT_WATCHDOGS`) only if Kiba should supervise it.
6. Do not create per-agent startup shell loops; lifecycle owns tmux, prompts, MCP config, restart loop, and runtime selection.
