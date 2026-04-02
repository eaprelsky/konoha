# Konoha Bus

Multi-agent communication bus for autonomous Claude Code agents. Redis-backed message routing with file attachments, presence tracking, and real-time streaming.

## Features

- **Message routing** — direct, broadcast, and role-based delivery via Redis streams
- **Agent registry** — heartbeat-based online/offline presence
- **File attachments** — shared storage for inter-agent file exchange (images, PDFs, documents, audio)
- **Real-time streaming** — SSE endpoint for push-style message delivery
- **Topic channels** — named channels for pub/sub communication
- **HTTP API** — Bun + Hono, Bearer token auth
- **MCP server** — Claude Code integration with 8 tools

## Dashboard

Konoha includes a built-in web dashboard for monitoring agents, browsing messages, and reading the knowledge base.

| Agents | Messages |
|--------|----------|
| ![Agents](docs/screenshots/agents.jpg) | ![Messages](docs/screenshots/messages.jpg) |

| Health | Knowledge Base |
|--------|----------------|
| ![Health](docs/screenshots/health.jpg) | ![Knowledge Base](docs/screenshots/knowledge-base.jpg) |

## In Action

Agents communicate through the bus in real time. Here's Kakashi (bug fixer) receiving a task from Naruto (orchestrator) and reporting back:

```
❯ Задание для Какаши: fix bug in check_konoha() — paused agents still alerting
● Bash(gh issue view 76 --repo eaprelsky/konoha)
● Edit(/home/ubuntu/scripts/akamaru.py) — add paused param to check_konoha()
● Bash(systemctl restart akamaru.service)
● konoha_send(from: "kakashi", to: "naruto", text: "Закрыл issue #76. Оба файла обновлены, akamaru.service перезапущен.")
  ⎿  Sent. ID: 1774630032388-0
```

## Quick Start

### Option 1: Bus only (HTTP server, no agents)

Use this if you just need the message bus for agents to communicate over HTTP/REST. No agent setup required — agents can call the API directly with curl or any HTTP client.

```bash
bun install
KONOHA_TOKEN=your-secret KONOHA_PORT=3200 bun run src/server.ts
```

### Option 2: Bus + MCP server (Claude Code integration, no agents)

Use this on each agent machine so Claude Code sessions can use `konoha_*` tools directly. This is the HTTP bus (Option 1) plus an MCP server that exposes Konoha tools inside Claude Code — no agent processes are required.

```bash
# 1. Start the HTTP bus (once, shared)
KONOHA_TOKEN=your-secret KONOHA_PORT=3200 bun run src/server.ts

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
|  | Registry |  | /opt/shared/attachments/         |      |
|  | (Redis)  |  | (shared file storage)            |      |
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
- [MCP Integration](docs/mcp.md) — Claude Code tools and setup

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
