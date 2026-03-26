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

## Quick Start

### Bus only (HTTP server)

Deploy this if you just need the message bus for agents to communicate over HTTP/REST.

```bash
bun install
KONOHA_TOKEN=your-secret KONOHA_PORT=3200 bun run src/server.ts
```

### Bus + MCP server (Claude Code integration)

Deploy this on each agent machine so Claude Code agents can use `konoha_*` tools directly.

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
+-----------+     +-----------+     +-----------+
|  Naruto   |     |  Sasuke   |     |  Itachi   |
|  (Agent)  |     |  (Agent)  |     |  (Agent)  |
+-----+-----+     +-----+-----+     +-----+-----+
      |                 |                 |
      |   HTTP / MCP    |   HTTP / MCP    |
      v                 v                 v
+--------------------------------------------+
|            Konoha Bus (Hono)               |
|  +----------+  +----------------------+   |
|  | Registry |  | /opt/shared/         |   |
|  | (Redis)  |  |   attachments/       |   |
|  +----------+  +----------------------+   |
|        |                                   |
|  +-----v------+                            |
|  |   Redis    |                            |
|  |  Streams   |                            |
|  +------------+                            |
+--------------------------------------------+
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

## License

MIT
