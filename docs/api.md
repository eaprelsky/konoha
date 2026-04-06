# Konoha Bus — API Reference

## Authentication

Konoha uses two types of tokens:

| Token | How to get | Permissions |
|-------|-----------|-------------|
| **Admin token** (`KONOHA_TOKEN`) | Set via env var at server startup | Full access — read any inbox, manage all agents, create invites |
| **Agent token** | Returned by `POST /agents/register` | Own inbox only — read own messages, send own heartbeat, send messages |

All endpoints except `/health` and `POST /agents/register` require Bearer token authentication:
```
Authorization: Bearer $TOKEN
```

`POST /agents/register` accepts either the admin token or a one-time invite token (see below).

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

### POST /agents/invite *(admin only)*

Generate a one-time invite token for registering a new agent. The token expires in 1 hour and is invalidated immediately after use.

```bash
curl -X POST -H "Authorization: Bearer $KONOHA_TOKEN" \
  http://127.0.0.1:3200/agents/invite
```

Response (201):
```json
{
  "token": "inv-99b83b3a-8b17-4c99-8507-7d08340269c5",
  "expiresAt": "2026-03-26T11:25:12.266Z"
}
```

### POST /agents/register

Register a new agent or update existing registration. Sets status to `online`.

Requires either the **admin token** or a valid **invite token** (one-time use, expires after registration).

```bash
# With admin token
curl -X POST -H "Authorization: Bearer $KONOHA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "naruto",
    "name": "Naruto (Agent #1)",
    "roles": ["orchestrator"],
    "capabilities": ["orchestration", "telegram-bot", "code"]
  }' \
  http://127.0.0.1:3200/agents/register

# With invite token (one-time)
curl -X POST -H "Authorization: Bearer inv-99b83b3a-..." \
  -H "Content-Type: application/json" \
  -d '{"id": "new-agent", "name": "New Agent"}' \
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
  "lastHeartbeat": 1774441043909,
  "token": "dc3ea480-c9cc-4656-94b1-72f14b6c4068"
}
```

> **`token`** — the agent's personal token for subsequent API calls. Store as `KONOHA_AGENT_TOKEN`. Each re-registration rotates the token.

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
| from | admin only | Sender agent ID. **Ignored for agent tokens** — sender is set from the token identity automatically (prevents impersonation). |
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

## Knowledge Base API

### GET /api/kb/tree

Canonical endpoint that returns the file tree of the Knowledge Base root.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3200/api/kb/tree
```

### GET /api/kb

Alias that redirects to `/api/kb/tree` (301).

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3200/api/kb
```

### GET /api/kb/file

Returns file content by relative path.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:3200/api/kb/file?path=path/to/file.md"
```

### GET /api/kb/search

Full-text search in .md files.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:3200/api/kb/search?q=search+query"
```

> **Note:** Always use `/api/kb/tree` as the canonical endpoint. The `/api/kb` redirect may not work in all proxy configurations.

## Channels

### GET /channels

List all active topic channels.

### GET /channels/:name/history

Read message history for a topic channel.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3200/channels/ops/history?count=20
```

## Agent Lifecycle

### POST /agents

Create a new agent definition.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-agent",
    "name": "My Agent",
    "model": "claude-sonnet-4-6",
    "system_prompt": "You are a helpful assistant.",
    "capabilities": ["yandex-tracker"]
  }' \
  http://127.0.0.1:3200/agents
```

### GET /agents

List all agent definitions. Add `?online=true` to filter by bus status.

### GET /agents/:id

Get a single agent definition with its current runtime state.

### PUT /agents/:id

Update agent definition fields (name, model, system_prompt, capabilities, etc.).

### DELETE /agents/:id

Delete an agent definition. Returns 403 for protected (system) agents.

### GET /agents/:id/status

Get the current runtime state (status, pid, uptime, tmux session).

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3200/agents/kakashi/status
```

### POST /agents/:id/start

Start a stopped agent (creates tmux session + injects startup message).

### POST /agents/:id/stop

Stop a running agent (sends /exit, then force-kills if needed).

### POST /agents/:id/restart

Stop + start in sequence. Regenerates CLAUDE.md and .mcp.json.

### GET /agents/:id/system-template

Return the rendered system template for this agent.

### GET /agents/tmux/:id

Check if a tmux session for this agent is currently alive.

### Agent memory endpoints

All require admin token.

- `GET /agents/:id/memory` — list memory files for this agent
- `GET /agents/:id/memory/:filename` — read a memory file
- `PUT /agents/:id/memory/:filename` — overwrite a memory file
- `POST /agents/:id/memory/:filename` — append to a memory file
- `DELETE /agents/:id/memory/:filename` — delete a memory file

### POST /agents/:id/avatar

Upload an avatar image for the agent (multipart/form-data, field: `file`).

### POST /admin/seed-system-agents

Re-run system agent seed (idempotent — skips existing).

---

## Skills

All skill endpoints require authentication.

### GET /skills

List all skills.

### POST /skills

Create a skill.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Яндекс Трекер",
    "description": "Работа с задачами",
    "prompt_snippet": "Use tracker_* MCP tools.",
    "mcp_servers": [{"name": "tracker", "command": "bun", "args": ["run", "/path/index.ts"]}]
  }' \
  http://127.0.0.1:3200/skills
```

### PATCH /skills/:id

Update skill fields (partial update).

### DELETE /skills/:id

Delete a skill.

---

## Roles

### GET /roles

List all roles.

### POST /roles

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role_id": "manager", "name": "Менеджер", "description": "Process manager", "strategy": "manual"}' \
  http://127.0.0.1:3200/roles
```

### PATCH /roles/:id

Update role fields.

### DELETE /roles/:id

Delete a role.

---

## People

### GET /people

List all people (merged: file-based from `.trusted-users.json` + custom from Redis).

### POST /people

Create a custom person record.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Иван Петров",
    "tg_id": 123456789,
    "position": "Project Manager",
    "tg_username": "ivanpetrov",
    "email": "ivan@example.com",
    "bitrix24_id": "42",
    "tracker_login": "ivanp"
  }' \
  http://127.0.0.1:3200/people
```

### DELETE /people/:id

Delete a custom person. Returns 403 for file-based (trusted) users.

### POST /people/:id/avatar

Upload an avatar for a person (multipart/form-data, field: `file`).

---

## Data Adapters (Information Systems)

### GET /adapters

List all registered data adapters with their in-memory stats (last success/error, active listeners).

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3200/adapters
```

### GET /adapters/:name/health

Check adapter connectivity. Returns 200 if healthy, 503 if not.

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3200/adapters/bitrix/health
# {"adapter": "bitrix", "healthy": true}
```

Available adapters: `bitrix`, `telegram`, `tracker`.

---

## Trigger Resolver

See [event-system.md](event-system.md) for full documentation.

### POST /api/trigger-resolver/resolve

Classify a single event label into a trigger descriptor.

### POST /api/trigger-resolver/resolve-batch

Classify multiple event labels in one call.

---

## Event Manager

See [event-system.md](event-system.md) for full documentation.

### POST /api/event-manager/subscribe

Create a trigger subscription.

### DELETE /api/event-manager/subscribe/:id

Cancel a subscription.

### GET /api/event-manager/subscriptions

List all active subscriptions.
