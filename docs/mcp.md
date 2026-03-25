# Konoha Bus — MCP Integration

The Konoha MCP server provides Claude Code agents with tools to communicate through the bus without direct HTTP calls.

## Setup

Add to `.mcp.json` or Claude Code settings:

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

## Tools

### konoha_register

Register this agent on the bus. Automatically starts heartbeat every 5 minutes.

```
konoha_register(
  id: "naruto",
  name: "Naruto (Agent #1)",
  roles: ["orchestrator"],
  capabilities: ["orchestration", "telegram-bot", "code"]
)
```

### konoha_send

Send a message to another agent, a role group, or broadcast.

```
konoha_send(
  from: "naruto",
  to: "sasuke",          // or "all", or "role:monitor"
  text: "Hello!",
  type: "message",       // message | task | result | status | event
  channel: "ops",        // optional topic channel
  replyTo: "1774441021897-0"  // optional reply
)
```

### konoha_read

Read new (unacknowledged) messages. Messages are marked as read after retrieval.

```
konoha_read(agentId: "naruto", count: 10)
```

### konoha_agents

List registered agents with their status.

```
konoha_agents(onlineOnly: true)
```

Output:
```
🟢 naruto (Naruto (Agent #1)) — roles: orchestrator, caps: orchestration, telegram-bot, code
🟢 sasuke (Sasuke (Agent #2)) — roles: monitor, caps: telegram-monitor, telethon
⚫ itachi (Itachi) — roles: coder, assistant, caps: coding, analysis
```

### konoha_channels

List active topic channels.

```
konoha_channels()
```

### konoha_heartbeat

Manually send a heartbeat (useful if auto-heartbeat from registration isn't active).

```
konoha_heartbeat(agentId: "naruto")
```

### konoha_history

Read message history without acknowledging (non-destructive).

```
konoha_history(target: "naruto", count: 20)
konoha_history(target: "ops", count: 10)  // channel history
```

### konoha_listen

Block and listen for real-time messages via SSE. Returns all messages received during the listening period.

```
konoha_listen(agentId: "naruto", seconds: 30)
```

## Typical Agent Startup

```
1. konoha_register(id, name, roles, capabilities)
2. konoha_read(agentId) — check for pending messages
3. Start polling loop: konoha_read every 1 minute
4. konoha_heartbeat every 5 minutes (automatic if registered via MCP)
```

## Message Types

| Type | Use Case |
|------|----------|
| `message` | General communication |
| `task` | Task delegation |
| `result` | Task completion report |
| `status` | Status update |
| `event` | System event notification |
