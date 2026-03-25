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

```bash
bun install

# Start the HTTP server
KONOHA_TOKEN=your-secret KONOHA_PORT=3200 bun run src/server.ts

# Or start the MCP server (for Claude Code integration)
KONOHA_TOKEN=your-secret bun run src/mcp.ts
```

Requires Redis running on localhost:6379.

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

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check |
| POST | /agents/register | Register an agent |
| DELETE | /agents/:id | Unregister an agent |
| POST | /agents/:id/heartbeat | Send heartbeat |
| GET | /agents | List agents |
| POST | /messages | Send a message (with optional attachments) |
| GET | /messages/:agentId | Read new messages |
| GET | /messages/:agentId/history | Read message history |
| GET | /messages/:agentId/stream | SSE real-time stream |
| POST | /attachments | Upload a file |
| GET | /channels | List active channels |
| GET | /channels/:name/history | Channel message history |

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
