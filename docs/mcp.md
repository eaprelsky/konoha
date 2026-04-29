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
  id: "bot-agent",
  name: "Бот-агент",
  display_alias: "Наруто",
  roles: ["orchestrator"],
  capabilities: ["orchestration", "telegram-bot", "code"]
)
```

### konoha_send

Send a message to another agent, a role group, or broadcast.

```
konoha_send(
  from: "bot-agent",
  to: "user-agent",      // or "all", or "role:monitor"
  text: "Hello!",
  type: "message",       // message | task | result | status | event
  channel: "ops",        // optional topic channel
  replyTo: "1774441021897-0"  // optional reply
)
```

### konoha_read

Read new (unacknowledged) messages. Messages are marked as read after retrieval.

```
konoha_read(agentId: "bot-agent", count: 10)
```

### konoha_agents

List registered agents with their status.

```
konoha_agents(onlineOnly: true)
```

Output:
```
🟢 bot-agent (Бот-агент, alias: Наруто) — roles: orchestrator, caps: orchestration, telegram-bot, code
🟢 user-agent (Юзер-агент, alias: Саске) — roles: monitor, caps: telegram-monitor, telethon
⚫ remote-operator (Удалённый оператор, alias: Итачи) — roles: coder, assistant, caps: coding, analysis
```

### konoha_channels

List active topic channels.

```
konoha_channels()
```

### konoha_heartbeat

Manually send a heartbeat (useful if auto-heartbeat from registration isn't active).

```
konoha_heartbeat(agentId: "bot-agent")
```

### konoha_history

Read message history without acknowledging (non-destructive).

```
konoha_history(target: "bot-agent", count: 20)
konoha_history(target: "ops", count: 10)  // channel history
```

### konoha_listen

Block and listen for real-time messages via SSE. Returns all messages received during the listening period.

```
konoha_listen(agentId: "bot-agent", seconds: 30)
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

### skill: testbench

Activate: add "testbench" to KONOHA_SKILLS  
Service: konoha-testbench.service (port 3203)

**Tools:**
- `konoha_testbench_navigate(url)` — navigate to URL
- `konoha_testbench_action(type, selector?, text?, amount?, key?)` — interact with page
- `konoha_testbench_snapshot()` — full page snapshot
- `konoha_testbench_resize(width, height)` — set viewport
- `konoha_testbench_reset()` — reset browser state
- `konoha_testbench_status()` — pool health

**Example:**
```
navigate url=http://127.0.0.1:3200/ui/
snapshot → check bounding_boxes + accessibility_tree
action type=click selector="button.sign-in"
```
