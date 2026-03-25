#!/usr/bin/env python3
"""
MCP Server for Telegram User Account.

Exposes Telegram user account messages to Claude Code via MCP protocol.
Reads from Redis streams (populated by bus.py) and writes responses back.

Tools:
- tg_read_messages: Read recent messages from a chat
- tg_send_message: Send a message to a chat
- tg_list_chats: List available chats
- tg_search_history: Search message history
"""

import json
import sys
import redis

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

# Redis connection
r = redis.Redis(host='localhost', port=6379, decode_responses=True)

STREAM_INCOMING = 'telegram:incoming'
STREAM_OUTGOING = 'telegram:outgoing'
STREAM_LOG = 'telegram:log'
GROUP_NAME = 'claude-agents'

app = Server("telethon-mcp")

@app.call_tool()
async def call_tool(name: str, arguments: dict):
    if name == "tg_read_new":
        count = arguments.get("count", 10)
        consumer_id = f"claude-{id(app)}"

        try:
            # Ensure consumer group exists
            try:
                r.xgroup_create(STREAM_INCOMING, GROUP_NAME, id='0', mkstream=True)
            except redis.ResponseError:
                pass

            messages = r.xreadgroup(
                GROUP_NAME, consumer_id,
                {STREAM_INCOMING: '>'},
                count=count, block=1000
            )

            result = []
            for stream, msgs in messages:
                for msg_id, data in msgs:
                    result.append(data)
                    r.xack(STREAM_INCOMING, GROUP_NAME, msg_id)

            if not result:
                return [TextContent(type="text", text="No new messages.")]

            formatted = []
            for m in result:
                chat = m.get('chat_title', '?')
                sender = m.get('sender_name', '?')
                text = m.get('text', '')
                ts = m.get('timestamp', '')[:19]
                msg_id = m.get('msg_id', '')
                chat_id = m.get('chat_id', '')
                is_group = m.get('is_group', '0') == '1'
                formatted.append(f"[{ts}] {'🏢' if is_group else '👤'} {chat} (chat_id: {chat_id}) | {sender}: {text}")

            return [TextContent(type="text", text="\n".join(formatted))]

        except Exception as e:
            return [TextContent(type="text", text=f"Error: {e}")]

    elif name == "tg_read_recent":
        count = arguments.get("count", 20)
        chat_filter = arguments.get("chat_filter", "").lower()

        messages = r.xrevrange(STREAM_LOG, count=count * 3)  # Over-fetch for filtering
        result = []
        for msg_id, data in messages:
            if chat_filter and chat_filter not in data.get('chat_title', '').lower():
                continue
            chat = data.get('chat_title', '?')
            sender = data.get('sender_name', '?')
            text = data.get('text', '')
            ts = data.get('timestamp', '')[:19]
            chat_id = data.get('chat_id', '')
            msg_id_tg = data.get('msg_id', '')
            result.append(f"[{ts}] {chat} (chat_id: {chat_id}, msg_id: {msg_id_tg}) | {sender}: {text}")
            if len(result) >= count:
                break

        result.reverse()
        if not result:
            return [TextContent(type="text", text="No recent messages found.")]
        return [TextContent(type="text", text="\n".join(result))]

    elif name == "tg_send":
        chat_id = arguments["chat_id"]
        text = arguments["text"]
        reply_to = arguments.get("reply_to", "")

        r.xadd(STREAM_OUTGOING, {
            "chat_id": chat_id,
            "text": text,
            "reply_to": reply_to or ""
        })

        return [TextContent(type="text", text=f"Message queued for chat {chat_id}")]

    elif name == "tg_list_chats":
        # Get unique chats from recent log
        messages = r.xrevrange(STREAM_LOG, count=200)
        chats = {}
        for msg_id, data in messages:
            cid = data.get('chat_id', '')
            title = data.get('chat_title', '?')
            is_group = data.get('is_group', '0') == '1'
            if cid not in chats:
                chats[cid] = {
                    'title': title,
                    'is_group': is_group,
                    'last_message': data.get('text', '')[:50],
                    'last_time': data.get('timestamp', '')[:19]
                }

        result = []
        for cid, info in chats.items():
            icon = '🏢' if info['is_group'] else '👤'
            result.append(f"{icon} {info['title']} (chat_id: {cid}) | last: {info['last_time']} | {info['last_message']}")

        return [TextContent(type="text", text="\n".join(result) if result else "No chats found.")]

    elif name in ("tg_edit", "tg_react", "tg_history", "tg_leave_chat", "tg_get_reactions"):
        import uuid
        request_id = str(uuid.uuid4())[:8]

        cmd_map = {
            "tg_edit": "edit",
            "tg_react": "react",
            "tg_history": "history",
            "tg_leave_chat": "leave",
            "tg_get_reactions": "get_reactions",
        }

        cmd_data = {"command": cmd_map[name], "request_id": request_id}
        cmd_data.update({k: str(v) for k, v in arguments.items() if v})

        r.xadd("telegram:commands", cmd_data)

        # Wait for result (max 15 seconds)
        import time
        for _ in range(30):
            result_raw = r.get(f"telegram:result:{request_id}")
            if result_raw:
                result = json.loads(result_raw)
                return [TextContent(type="text", text=result.get("data", "no data"))]
            time.sleep(0.5)

        return [TextContent(type="text", text="Timeout waiting for response")]

    return [TextContent(type="text", text=f"Unknown tool: {name}")]

@app.list_tools()
async def list_tools_extended():
    return [
        Tool(
            name="tg_read_new",
            description="Read new unprocessed messages from Telegram chats.",
            inputSchema={
                "type": "object",
                "properties": {
                    "count": {"type": "integer", "description": "Max messages to read", "default": 10}
                }
            }
        ),
        Tool(
            name="tg_read_recent",
            description="Read recent messages from the log. Useful for getting context.",
            inputSchema={
                "type": "object",
                "properties": {
                    "count": {"type": "integer", "description": "Number of recent messages", "default": 20},
                    "chat_filter": {"type": "string", "description": "Filter by chat title (substring)", "default": ""}
                }
            }
        ),
        Tool(
            name="tg_send",
            description="Send a message to a Telegram chat via the user account.",
            inputSchema={
                "type": "object",
                "properties": {
                    "chat_id": {"type": "string", "description": "Chat ID"},
                    "text": {"type": "string", "description": "Message text"},
                    "reply_to": {"type": "string", "description": "Message ID to reply to", "default": ""}
                },
                "required": ["chat_id", "text"]
            }
        ),
        Tool(
            name="tg_edit",
            description="Edit a previously sent message.",
            inputSchema={
                "type": "object",
                "properties": {
                    "chat_id": {"type": "string", "description": "Chat ID"},
                    "msg_id": {"type": "string", "description": "Message ID to edit"},
                    "text": {"type": "string", "description": "New message text"}
                },
                "required": ["chat_id", "msg_id", "text"]
            }
        ),
        Tool(
            name="tg_react",
            description="Add an emoji reaction to a message.",
            inputSchema={
                "type": "object",
                "properties": {
                    "chat_id": {"type": "string", "description": "Chat ID"},
                    "msg_id": {"type": "string", "description": "Message ID to react to"},
                    "emoji": {"type": "string", "description": "Emoji reaction (e.g. 👍, ❤, 🔥)", "default": "👍"}
                },
                "required": ["chat_id", "msg_id"]
            }
        ),
        Tool(
            name="tg_history",
            description="Read message history from a specific chat. Gets older messages beyond what's in Redis.",
            inputSchema={
                "type": "object",
                "properties": {
                    "chat_id": {"type": "string", "description": "Chat ID"},
                    "limit": {"type": "integer", "description": "Number of messages to fetch", "default": 30}
                },
                "required": ["chat_id"]
            }
        ),
        Tool(
            name="tg_list_chats",
            description="List chats that have had recent activity.",
            inputSchema={"type": "object", "properties": {}}
        ),
        Tool(
            name="tg_leave_chat",
            description="Leave a group chat.",
            inputSchema={
                "type": "object",
                "properties": {
                    "chat_id": {"type": "string", "description": "Chat ID to leave"}
                },
                "required": ["chat_id"]
            }
        ),
        Tool(
            name="tg_get_reactions",
            description="Get reactions on a specific message.",
            inputSchema={
                "type": "object",
                "properties": {
                    "chat_id": {"type": "string", "description": "Chat ID"},
                    "msg_id": {"type": "string", "description": "Message ID"}
                },
                "required": ["chat_id", "msg_id"]
            }
        ),
    ]

async def main():
    from mcp.server.models import InitializationOptions
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, InitializationOptions(
            server_name="telethon-mcp",
            server_version="1.0.0",
        ))

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
