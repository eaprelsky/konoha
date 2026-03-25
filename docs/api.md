# Konoha Bus — API Reference

All endpoints except `/health` require Bearer token authentication:
```
Authorization: Bearer $KONOHA_TOKEN
```

Base URL: `http://127.0.0.1:3200`

## Health

### GET /health

```bash
curl http://127.0.0.1:3200/health
```

Response:
```json
{"status": "ok", "ts": "2026-03-25T12:00:00.000Z"}
```

## Agents

### POST /agents/register

Register a new agent or update existing registration. Sets status to `online`.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "naruto",
    "name": "Naruto (Agent #1)",
    "roles": ["orchestrator"],
    "capabilities": ["orchestration", "telegram-bot", "code"]
  }' \
  http://127.0.0.1:3200/agents/register
```

Response (201):
```json
{
  "id": "naruto",
  "name": "Naruto (Agent #1)",
  "capabilities": ["orchestration", "telegram-bot", "code"],
  "roles": ["orchestrator"],
  "status": "online",
  "lastHeartbeat": 1774441043909
}
```

### POST /agents/:id/heartbeat

Keep agent status `online`. Agents with no heartbeat for 10 minutes are marked `offline`.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3200/agents/naruto/heartbeat
```

Response: `{"ok": true}`

### GET /agents

List all registered agents. Add `?online=true` to filter.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3200/agents?online=true
```

### DELETE /agents/:id

Unregister an agent. Add `?hard=true` to remove from registry entirely (default: sets status to `offline`).

## Messages

### POST /messages

Send a message to an agent, a role group, or broadcast to all.

**Routing:**
- `"to": "sasuke"` — direct message to agent
- `"to": "all"` — broadcast to all online agents (except sender)
- `"to": "role:monitor"` — send to all agents with the specified role

**Message types:** `message`, `task`, `result`, `status`, `event`

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "naruto",
    "to": "sasuke",
    "type": "message",
    "text": "Hello from Naruto",
    "attachments": [
      {
        "name": "report.pdf",
        "path": "/opt/shared/attachments/naruto-1774441029710.pdf",
        "mime": "application/pdf"
      }
    ]
  }' \
  http://127.0.0.1:3200/messages
```

Response: `{"id": "1774441021897-0"}`

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| from | yes | Sender agent ID |
| to | yes | Recipient: agent ID, `"all"`, or `"role:<role>"` |
| text | yes | Message text |
| type | no | Message type (default: `message`) |
| channel | no | Topic channel name |
| replyTo | no | Message ID this is a reply to |
| attachments | no | Array of attachment objects (see [attachments.md](attachments.md)) |

### GET /messages/:agentId

Read new (unacknowledged) messages for an agent. Messages are acknowledged and won't be returned again.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3200/messages/naruto?count=10
```

Response:
```json
[
  {
    "id": "1774441021897-0",
    "from": "sasuke",
    "to": "naruto",
    "type": "message",
    "text": "Hello from Sasuke",
    "timestamp": "2026-03-25T12:17:01.897Z",
    "attachments": [
      {
        "name": "screenshot.jpg",
        "path": "/opt/shared/attachments/sasuke-1774441100000.jpg",
        "mime": "image/jpeg",
        "size": 102839
      }
    ]
  }
]
```

### GET /messages/:agentId/history

Read message history (does not acknowledge — read-only).

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3200/messages/naruto/history?count=20
```

### GET /messages/:agentId/stream

Server-Sent Events (SSE) stream for real-time message delivery. Sends `ping` every 30s.

```bash
curl -N -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3200/messages/naruto/stream
```

Events:
```
event: message
data: {"from":"sasuke","to":"naruto","type":"message","text":"Hello"}

event: ping
data:
```

## Channels

### GET /channels

List all active topic channels.

### GET /channels/:name/history

Read message history for a topic channel.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3200/channels/ops/history?count=20
```
