# Konoha Agent Team

Multi-agent system built on Claude Code. Agents communicate via the [Konoha bus](../README.md),
receive tasks through watchdog services, and operate autonomously.

## Team Roster

| # | Agent | Model | Role | tmux | Status |
|---|-------|-------|------|------|--------|
| 1 | [Naruto](naruto/CLAUDE.md) | Sonnet | Main orchestrator, Telegram bot | `naruto` | Permanent |
| 2 | [Sasuke](sasuke/CLAUDE.md) | Sonnet | Telegram user account monitor | `sasuke` | Permanent |
| 3 | [Mirai](mirai/CLAUDE.md) | Haiku | Email and data processing | `mirai` | Permanent |
| 4 | [Jiraiya](jiraiya/CLAUDE.md) | Sonnet | Chronicler — classifies and archives events | `jiraiya` | Permanent |
| 5 | [Shino](shino/CLAUDE.md) | Sonnet | QA Lead — test plans, testing coordination | `shino` | Permanent |
| 6 | [Hinata](hinata/CLAUDE.md) | Haiku | QA Runner — runs tests, writes reports | `hinata` | Permanent |
| 7 | [Kiba](kiba/CLAUDE.md) | Sonnet | System guardian — monitoring, alerts | `kiba` | Permanent |
| 8 | [Kakashi](kakashi/CLAUDE.md) | Sonnet | Bug fixer — reads GitHub Issues, fixes code | `kakashi` | Permanent |
| 10 | [Guy](guy/CLAUDE.md) | Haiku | Kakashi's sub-agent — fast mechanical tasks (translate, scaffold, replace) | `guy` | Permanent |
| 9 | [Ibiki](ibiki/CLAUDE.md) | Sonnet | Security pentester — audits Konoha infrastructure | `ibiki` | On-demand |
| — | [Itachi](itachi/CLAUDE.md) | Sonnet+ | Local WSL agent (on owner's machine) | `itachi` | Optional |
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

Each permanent agent has two services:
- `claude-{agent}.service` — starts Claude Code in tmux
- `claude-watchdog-{agent}.service` — delivers events to the agent

Additionally: `akamaru.service` — autonomous system health monitoring.

## Adding a New Agent

1. Create `agents/{name}/CLAUDE.md` with the agent's role description
2. Create `agents/{name}/.mcp-{name}.json` using `agents/.mcp-template.json` as template
3. Create `scripts/claude-{name}-service.sh` and `scripts/watchdog-{name}.py`
4. Create systemd unit files and enable them
5. Add the agent to the table above
6. Add the session to `WATCHED_SESSIONS` in `scripts/akamaru.py`
