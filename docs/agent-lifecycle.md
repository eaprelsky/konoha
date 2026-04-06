# Agent Lifecycle — Technical Reference

`src/agent-lifecycle.ts`

The agent lifecycle module manages two separate concerns:

- **Persistent definitions** — what an agent is (name, model, skills, system prompt)
- **Runtime state** — whether the agent is running, in which tmux session, since when

Both are stored in Redis and survive server restarts.

---

## Data model

### AgentDef (persistent definition)

```ts
interface AgentDef {
  id: string;                         // unique agent ID (e.g. "naruto", "kakashi")
  name: string;                       // display name
  model: string;                      // Claude model ID (e.g. "claude-sonnet-4-6")
  system_prompt?: string;             // user-editable instructions (appended after system template)
  env?: Record<string, string>;       // custom env vars for this agent's process
  tags?: string[];                    // labels (e.g. ["system"])
  capabilities?: string[];            // skill IDs assigned to this agent
  memory?: string;                    // path to agent memory file
  avatar_url?: string;
  gender?: 'male' | 'female' | 'neutral';
  protected?: boolean;                // system agents — cannot be deleted
  tmux_session_override?: string;     // use this tmux session name instead of konoha-{id}
  created_at: string;
  updated_at: string;
}
```

Stored in Redis hash `konoha:agent-defs` (key: agent ID, value: JSON).

### AgentState (runtime state)

```ts
interface AgentState {
  agent_id: string;
  status: "stopped" | "starting" | "running" | "stopping" | "error";
  pid?: number;
  started_at?: string;
  tmux_session?: string;
  error?: string;
  uptime_seconds?: number;            // computed on read, not persisted
}
```

Stored in Redis hash `konoha:agent-states`.

### Audit log

Every lifecycle event (created, started, stopped, restarted, error) is appended to the Redis stream `konoha:agent-audit`.

---

## Starting an agent

`startAgent(id, def)` performs the following steps:

### 1. Prepare working directory

```
/opt/shared/agent-workdirs/{id}/
  CLAUDE.md      ← system template + user instructions + skill snippets
  .mcp.json      ← MCP server config
```

### 2. Generate CLAUDE.md

The file is assembled from three parts:

```
[System Template]
  - Agent identity (id, name, model)
  - Startup sequence (source /home/ubuntu/.agent-env, read MEMORY.md, konoha_register, wait for tasks)
  - Konoha bus connection info
---
[User Instructions]
  - AgentDef.system_prompt (editable in the UI)
---
[Skill Snippets]
  - For each skill in capabilities[]:
      ## Skill: {skill.name}
      {skill.prompt_snippet}
```

### 3. Generate .mcp.json

Always includes the Konoha MCP server (so agents can call `konoha_register`, `konoha_send`, `konoha_read`):

```json
{
  "mcpServers": {
    "konoha": {
      "command": "/home/ubuntu/.bun/bin/bun",
      "args": ["run", "/home/ubuntu/konoha/src/mcp.ts"],
      "env": {"KONOHA_URL": "...", "KONOHA_TOKEN": "..."}
    }
  }
}
```

For each skill in `capabilities[]`, its `mcp_servers` entries are merged in. Environment variable references (`${VAR}`) are resolved from `/opt/konoha/.env.global` and the agent's own `env` map.

### 4. Launch tmux session with restart loop

```bash
tmux new-session -d -s konoha-{id} -c /opt/shared/agent-workdirs/{id} bash -c "
  while true; do
    claude --model {model} --mcp-config .mcp.json
    echo '[date] Claude exited (code $?), restarting in 5s...'
    sleep 5
  done
"
```

The `while true` loop ensures Claude Code automatically restarts after processing a startup message and exiting (fixes #236).

### 5. Inject startup message

After a 7-second wait (for Claude Code to initialize):

```bash
tmux send-keys -t konoha-{id} "Прочитай CLAUDE.md и выполни startup sequence." Enter
```

The agent reads its CLAUDE.md, registers on the Konoha bus, and waits for tasks from the watchdog.

---

## Stopping an agent

`stopAgent(id)`:

1. Sends `/exit` command to the tmux session (graceful Claude Code exit)
2. Waits 1.2 seconds
3. If session is still alive — kills it with `tmux kill-session`

---

## Restarting an agent

`restartAgent(id, def)` = `stopAgent` → `startAgent`. CLAUDE.md and .mcp.json are regenerated on each start, so skill changes take effect on next restart.

---

## tmux session naming

Default: `konoha-{agent_id}` (e.g. `konoha-naruto`, `konoha-kakashi`).

System agents with `tmux_session_override` use their override name directly (e.g. `naruto`, `sasuke`, `kakashi`). This allows the UI to detect live status for manually started sessions.

---

## HTTP endpoints

### GET /agents/:id/status

Returns current `AgentState` for the agent.

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3200/agents/kakashi/status
```

```json
{
  "agent_id": "kakashi",
  "status": "running",
  "pid": 12345,
  "started_at": "2026-04-06T09:00:00.000Z",
  "tmux_session": "kakashi",
  "uptime_seconds": 3600
}
```

### POST /agents/:id/start

Start a stopped agent. Returns 409 if already running.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3200/agents/kakashi/start
```

### POST /agents/:id/stop

Stop a running agent.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3200/agents/kakashi/stop
```

### POST /agents/:id/restart

Stop + start in sequence.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3200/agents/kakashi/restart
```

### GET /agents/:id/system-template

Returns the rendered system template for a given agent (before appending user instructions).

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3200/agents/kakashi/system-template
```

---

## System agents

The following agents are seeded automatically on server start and are marked `protected: true` (cannot be deleted via API):

| ID | Name | Model | tmux override |
|----|------|-------|---------------|
| naruto | Наруто (Оркестратор) | claude-sonnet-4-6 | naruto |
| sasuke | Саске | claude-sonnet-4-6 | sasuke |
| kakashi | Какаши (Мастер багфиксинга) | claude-sonnet-4-6 | kakashi |
| mirai | Мирай | claude-haiku-4-5-20251001 | mirai |

Seed is idempotent — existing definitions are not overwritten. Can be re-run via `POST /admin/seed-system-agents`.
