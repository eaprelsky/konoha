# Telethon MCP + Redis Bus

## Architecture

```
Telegram Chats ←→ Telethon (bus.py) ←→ Redis Streams ←→ MCP Server ←→ Claude Code
```

## Components

### bus.py
Transport layer. Runs 24/7 as a daemon.
- Telethon listens to all Telegram chats
- Pushes incoming messages to Redis stream `telegram:incoming`
- Reads outgoing from Redis stream `telegram:outgoing` and sends via Telethon
- Logs all messages to `telegram:log` and wiki files

### mcp_server.py
MCP server for Claude Code sessions. Tools:
- `tg_read_new` — read unprocessed messages
- `tg_read_recent` — read recent messages (with chat filter)
- `tg_send` — send message to a chat
- `tg_list_chats` — list active chats

## Running

```bash
# Start the bus (run in tmux/systemd)
python3 -u bus.py

# Claude Code connects to MCP server automatically via .mcp.json:
# "telethon": {"command": "python3", "args": ["/home/ubuntu/telethon-mcp/mcp_server.py"]}
```

## Redis Streams

| Stream | Purpose |
|--------|---------|
| `telegram:incoming` | New messages for Claude to process |
| `telegram:outgoing` | Messages for Telethon to send |
| `telegram:log` | Full message log for context |
