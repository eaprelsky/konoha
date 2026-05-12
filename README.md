# Konoha

[![CI](https://github.com/eaprelsky/konoha/actions/workflows/ci.yml/badge.svg)](https://github.com/eaprelsky/konoha/actions/workflows/ci.yml)

AI-native BPMS and multi-agent control plane. Konoha combines an executable eEPC workflow engine, agent/runtime orchestration, Action Spine contracts, information-system connectors, and a React operator workspace.

## Features

- **Workflow Engine** — executable eEPC processes with cases, work items, events, roles, documents, and information-system bindings.
- **AI constructor** — assistant actions materialize process definitions through server-side action contracts.
- **Action Spine** — typed action envelope used by UI, HTTP, MCP, and agents to avoid divergent mutation paths.
- **Agent lifecycle** — managed Claude Code, Codex, and Cursor-style workers with runtime profiles, watchdogs, and health checks.
- **Message bus** — direct, broadcast, and role-based delivery via Redis streams, SSE, PostgreSQL shadow history, and attachments.
- **Connectors** — Telegram, email, GitHub, Bitrix, Yandex Tracker, Yonote, and other external systems as workflow information systems.
- **Operator workspace** — React UI for process design, work execution, monitoring, knowledge, agents, and administration.
- **MCP server** — Konoha tools for coding agents and operator assistants.

## Konoha WEB

Konoha includes a built-in operator workspace for designing executable processes, running cases, monitoring events, and managing agent runtime state.

| Process Editor | My Tasks |
|----------------|----------|
| ![Process Editor](docs/screenshots/process-editor.png) | ![My Tasks](docs/screenshots/my-tasks.png) |

| Process Monitoring | Runtime Monitoring |
|--------------------|--------------------|
| ![Process Monitoring](docs/screenshots/process-monitoring.png) | ![Runtime Monitoring](docs/screenshots/monitoring.png) |

| Agents | Messages |
|--------|----------|
| ![Agents](docs/screenshots/agents.png) | ![Messages](docs/screenshots/messages.png) |

| Knowledge Base | Connectors |
|----------------|------------|
| ![Knowledge Base](docs/screenshots/knowledgebase.png) | ![Connectors](docs/screenshots/connectors.png) |

| Documents | Skills |
|-----------|--------|
| ![Documents](docs/screenshots/documents.png) | ![Skills](docs/screenshots/skills.png) |

## In Action

Agents communicate through the bus in real time. Here's Kakashi (bug fixer) receiving a task from Naruto (orchestrator) and reporting back:

```
❯ Задание для Какаши: fix bug in check_konoha() — paused agents still alerting
● Bash(gh issue view 76 --repo eaprelsky/konoha)
● Edit(/home/ubuntu/konoha/scripts/akamaru.py) — add paused param to check_konoha()
● Bash(systemctl restart akamaru.service)
● konoha_send(from: "kakashi", to: "naruto", text: "Закрыл issue #76. Оба файла обновлены, akamaru.service перезапущен.")
  ⎿  Sent. ID: 1774630032388-0
```

## Quick Start

### Option 1: Bus only (HTTP server, no agents)

Use this if you just need the message bus for agents to communicate over HTTP/REST. No agent setup required — agents can call the API directly with curl or any HTTP client.

```bash
bun install
KONOHA_TOKEN=your-secret KONOHA_PORT=3200 bun run start
```

### Option 2: Bus + MCP server (Claude Code integration, no agents)

Use this on each agent machine so Claude Code, Codex, or Cursor sessions can use `konoha_*` tools directly. This is the HTTP bus (Option 1) plus an MCP server that exposes Konoha tools inside those coding agents — no managed agent processes are required.

```bash
# 1. Start the HTTP bus (once, shared)
KONOHA_TOKEN=your-secret KONOHA_PORT=3200 bun run start

# 2. Add MCP server to Claude Code settings (.mcp.json):
# {
#   "mcpServers": {
#     "konoha": {
#       "command": "bun",
#       "args": ["run", "/path/to/konoha/src/mcp.ts"],
#       "env": {
#         "KONOHA_URL": "http://127.0.0.1:3200",
#         "KONOHA_TOKEN": "your-secret"
#       }
#     }
#   }
# }
```

Requires Redis on localhost:6379.

### Option 3: Full stack (Bus + MCP + agents)

Use this when running multiple named Claude Code agents (e.g. Naruto, Sasuke, Mirai) that need to discover each other, exchange files, and route messages by agent ID. Combines Options 1 and 2 with agent registration and heartbeat-based presence tracking. See the [Registration flow](#registration-flow) below and [Architecture](docs/architecture.md) for the full setup.

### Registration flow

```bash
# 1. Admin creates a one-time invite token
curl -X POST -H "Authorization: Bearer $KONOHA_TOKEN" \
  http://127.0.0.1:3200/agents/invite
# → {"token": "inv-<uuid>", "expiresAt": "..."}

# 2. New agent registers with the invite token, receives its own token
curl -X POST -H "Authorization: Bearer inv-<uuid>" \
  -d '{"id":"my-agent","name":"My Agent"}' \
  http://127.0.0.1:3200/agents/register
# → {"id":"my-agent", ..., "token": "<agent-uuid>"}

# 3. Agent uses its token for all subsequent calls
export KONOHA_AGENT_TOKEN=<agent-uuid>
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for details.

```
+-----------+   +-----------+   +-----------+   +-----------+
|  Naruto   |   |  Sasuke   |   |  Itachi   |   |  Mirai    |
| (Agent #1)|   | (Agent #2)|   | (Agent #3)|   | (Agent #4)|
+-----+-----+   +-----+-----+   +-----+-----+   +-----+-----+
      |               |               |               |
      |         HTTP / MCP            |         HTTP / MCP
      v               v               v               v
+----------------------------------------------------------+
|                  Konoha Bus (Hono)                       |
|  +----------+  +----------------------------------+      |
|  | Presence |  | /opt/shared/attachments/         |      |
|  | (PG)     |  | (shared file storage)            |      |
|  +----------+  +----------------------------------+      |
|        |                                                  |
|  +-----v------+                                          |
|  |   Redis    |                                          |
|  |  Streams   |                                          |
|  +------------+                                          |
+----------------------------------------------------------+
```

## Documentation

- [API Reference](docs/api.md) — HTTP endpoints, request/response formats
- [Attachments](docs/attachments.md) — file exchange between agents
- [Architecture](docs/architecture.md) — system design, message flow, deployment
- [MCP Integration](docs/mcp.md) — Claude Code / Codex / Cursor tool setup
- [AI-Native Operator Constitution](docs/governance/ai-native-operator-constitution.md) — governing document for Tsunade/operator architecture work

## API Quick Reference

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /health | none | Health check |
| POST | /agents/invite | admin | Issue one-time invite token (1h TTL) |
| POST | /agents/register | admin or invite token | Register an agent, returns per-agent token |
| DELETE | /agents/:id | admin | Unregister an agent |
| POST | /agents/:id/heartbeat | own agent or admin | Send heartbeat |
| GET | /agents | any | List agents |
| POST | /messages | any | Send a message (`from` auto-set from token) |
| GET | /messages/:agentId | own agent or admin | Read new messages |
| GET | /messages/:agentId/history | any | Read message history |
| GET | /messages/:agentId/stream | any | SSE real-time stream |
| POST | /attachments | any | Upload a file |
| GET | /channels | any | List active channels |
| GET | /channels/:name/history | any | Channel message history |

## MCP Tools

| Tool | Description |
|------|-------------|
| konoha_register | Register on the bus (auto-heartbeat) |
| konoha_send | Send a message |
| konoha_read | Read new messages |
| konoha_agents | List agents |
| konoha_channels | List channels |
| konoha_heartbeat | Manual heartbeat |
| konoha_history | Read message/channel history |
| konoha_listen | Real-time SSE listener |

## Frontend

The UI is built with React 18 + TypeScript + Vite (multi-page).

### Development
```bash
cd frontend
bun install
bun run dev   # starts at http://localhost:5173
```

### Build
```bash
cd frontend
bun run build  # outputs to dist/ui/
```

The server serves built files from `dist/ui/` at the `/ui/` path. Pages: Dashboard (`/ui/index.html`), Process Registry (`/ui/processes.html`), Work Items (`/ui/workitems.html`).

## License

MIT
