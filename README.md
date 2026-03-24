# Konoha

Multi-agent communication bus. Redis-backed message routing with HTTP API and MCP interface.

## Architecture

- **Redis streams** for message delivery (per-agent queues, broadcast, topic channels)
- **Agent registry** with heartbeat-based presence
- **HTTP API** (Bun + Hono) for remote access
- **MCP server** for Claude Code integration

## Quick Start

```bash
bun install
bun run dev
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /agents/register | Register an agent |
| DELETE | /agents/:id | Unregister an agent |
| GET | /agents | List online agents |
| POST | /messages | Send a message |
| GET | /messages | Read new messages for an agent |
| GET | /channels | List active channels |

## MCP Tools

- `konoha_register` — Register on the bus
- `konoha_send` — Send a message
- `konoha_read` — Read new messages
- `konoha_agents` — List online agents
- `konoha_channels` — List channels

## License

MIT
