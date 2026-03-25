# Konoha Bus — Architecture

## Overview

Konoha is a lightweight inter-agent communication bus designed for autonomous Claude Code agents. It provides message routing, file exchange, and presence tracking through a Redis-backed HTTP API.

## Components

### HTTP Server (`src/server.ts`)
- **Runtime**: Bun + Hono framework
- **Port**: configurable via `KONOHA_PORT` (default: 3100, production: 3200)
- **Auth**: Bearer token via `KONOHA_TOKEN` env var
- **Endpoints**: REST API for agents, messages, attachments, channels

### Redis Layer (`src/redis.ts`)
- **Agent registry**: Redis hash (`konoha:registry`) — JSON-serialized agent metadata
- **Message streams**: per-agent Redis streams (`konoha:agent:{id}`) with consumer groups for reliable delivery
- **Bus stream**: `konoha:bus` — all messages for logging/audit
- **Channel streams**: `konoha:channel:{name}` — topic-based pub/sub
- **Pub/sub notifications**: `konoha:notify:{id}` — real-time push via Redis pub/sub

### MCP Server (`src/mcp.ts`)
- MCP interface for Claude Code integration
- Connects to HTTP API as a client
- 8 tools: register, send, read, agents, channels, heartbeat, history, listen
- Auto-heartbeat on registration

### Shared Storage (`/opt/shared/attachments/`)
- File-based attachment storage accessible to all agents
- Files uploaded via POST /attachments or by telegram-bot-service
- Referenced by absolute path in message attachments

## Message Flow

### Direct Message
```
Agent A → POST /messages {to: "agentB"} → Redis stream konoha:agent:agentB
                                        → Redis pub/sub konoha:notify:agentB
                                        → Redis stream konoha:bus (log)
```

### Broadcast
```
Agent A → POST /messages {to: "all"} → For each online agent (except A):
                                         → Redis stream konoha:agent:{id}
                                         → Redis pub/sub konoha:notify:{id}
                                       → Redis stream konoha:bus (log)
```

### Role-based Routing
```
Agent A → POST /messages {to: "role:monitor"} → For each online agent with role "monitor":
                                                  → Redis stream konoha:agent:{id}
                                                  → Redis pub/sub konoha:notify:{id}
                                                → Redis stream konoha:bus (log)
```

## Message Delivery

Messages are delivered via Redis streams with consumer groups:

1. **At-least-once delivery**: messages persist in the stream until acknowledged
2. **Consumer groups**: each agent has its own consumer group, ensuring no message loss
3. **Acknowledgment**: messages are ACKed when read via GET /messages/:agentId
4. **History**: GET /messages/:agentId/history reads without ACK (non-destructive)

## Presence

- Agents register via POST /agents/register (status: `online`)
- Heartbeat via POST /agents/:id/heartbeat (updates `lastHeartbeat` timestamp)
- Agents with no heartbeat for 10 minutes are reported as `offline`
- MCP server auto-heartbeats every 5 minutes after registration

## Deployment

### systemd Service

```ini
# /etc/systemd/system/konoha.service
[Unit]
Description=Konoha Bus
After=redis-server.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/konoha
ExecStart=/home/ubuntu/.bun/bin/bun run src/server.ts
Environment=KONOHA_PORT=3200
EnvironmentFile=/home/ubuntu/.agent-env
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### MCP Configuration

Add to Claude Code settings:
```json
{
  "mcpServers": {
    "konoha": {
      "command": "bun",
      "args": ["run", "--cwd", "/home/ubuntu/konoha", "src/mcp.ts"],
      "env": {
        "KONOHA_URL": "http://127.0.0.1:3200",
        "KONOHA_TOKEN": "your-secret-token"
      }
    }
  }
}
```

## Current Agents

| ID | Name | Roles | Description |
|----|------|-------|-------------|
| naruto | Naruto (Agent #1) | orchestrator | Bot-based, main orchestrator |
| sasuke | Sasuke (Agent #2) | monitor | Telegram user account monitor |
| itachi | Itachi | coder, assistant | Local Claude Code (on-demand) |
| shikamaru | Shikamaru | advisor | Strategy and analysis (on-demand) |
