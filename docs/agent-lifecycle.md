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
  runtime?: 'claude' | 'codex' | 'cursor' | 'glm';
  fallback_runtime?: 'claude' | 'codex' | 'cursor' | 'glm';
  llm_client_profile?: string;          // preferred: runtime adapter + provider + model profile
  fallback_llm_client_profile?: string;
  model: string;                      // provider-qualified model ID (e.g. "claude:sonnet", "codex:gpt-5.5")
  reasoning_effort?: string;          // provider-specific effort, e.g. "high" for Codex
  system_prompt?: string;             // user-editable instructions (appended after system template)
  env?: Record<string, string>;       // custom env vars for this agent's process
  tags?: string[];                    // labels (e.g. ["system"])
  capabilities?: string[];            // skill IDs assigned to this agent
  memory?: string;                    // path to agent memory file
  avatar_url?: string;
  gender?: 'male' | 'female' | 'neutral';
  protected?: boolean;                // system agents — cannot be deleted
  tmux_session_override?: string;     // compatibility/status hint; managed sessions use the agent id
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
  AGENTS.md      ← system template + user instructions + skill snippets
  .mcp.json      ← MCP server config
```

### 2. Generate AGENTS.md — Composite prompt

`buildSystemPrompt(agentId, def)` assembles a 5-layer prompt:

```
[Layer 1+2: System Template]
  - Agent identity (id, name, model)
  - Startup sequence (source /home/ubuntu/.agent-env, read MEMORY.md, konoha_register, wait for tasks)
  - Konoha bus connection info + watchdog behavior
---
[Layer 4: User Instructions]
  - AgentDef.system_prompt (editable in the UI)
---
[Layer 3: Role Blocks]
  - Built by buildRoleBlocks(agentId)
  - For each role where this agent is an assignee:
      ## Role: {role.name}
      ### Process: {workflow.name}
      #### {function.label}
      - Triggered by: {input events}
      - Produces: {output events}
      - Documents: ...
      - Systems: ...
      - Goal: ... (if intent is set)
---
[Layer 5: Skill Snippets]
  - For each skill in capabilities[]:
      ## Skill: {skill.name}
      {skill.prompt_snippet}
```

#### Role blocks — how they're built

`buildRoleBlocks(agentId)` uses a Redis index maintained by `workflow-loader`:

1. Reads `konoha:roles:all` (sorted set) — list of all role IDs
2. For each role, loads `role:{roleId}` and checks if `agentId` is in `assignees[]`
3. For matching roles, reads `konoha:role:{roleId}:workflows` (Set) — workflow IDs where this role appears
4. Loads each workflow via `getWorkflow(wfId)`, finds all `function` elements with `el.role === roleId`
5. For each function, builds adjacency maps from `wf.flow` edges to find:
   - **Input events** — event nodes with an outgoing edge to this function
   - **Output events** — event nodes with an incoming edge from this function
6. Formats everything as human-readable instruction blocks

The `konoha:role:{roleId}:workflows` index is updated automatically on `createWorkflow`, `updateWorkflow`, `loadWorkflows`, and cleaned on `archiveWorkflow`.

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

### 4. Launch runtime in isolated tmux with restart loop

```bash
tmux -L {id} new-session -d -s {id} -c /opt/shared/agent-workdirs/{id} bash -c "
  while true; do
    <runtime command built from AgentDef.runtime + AgentDef.model>
    echo '[date] runtime exited (code $?), restarting in 5s...'
    sleep 5
  done
"
```

The runtime command is built by `src/agent/runtime.ts` and may be Claude, Codex, Cursor, or GLM.
The `while true` loop ensures the interactive CLI automatically restarts after processing a startup message or crashing.

### 5. Inject startup message

After a 7-second wait (for Claude Code to initialize):

```bash
tmux -L {id} send-keys -t {id} "Прочитай AGENTS.md и выполни startup sequence." Enter
```

The agent reads its AGENTS.md, registers on the Konoha bus, and waits for tasks from the watchdog.

---

## Stopping an agent

`stopAgent(id)`:

1. Sends `/exit` command to the tmux session (graceful Claude Code exit)
2. Waits 1.2 seconds
3. If session is still alive — kills it with `tmux kill-session`

---

## Restarting an agent

`restartAgent(id, def)` = `stopAgent` → `startAgent`. AGENTS.md and .mcp.json are regenerated on each start, so skill and role changes take effect on next restart.

---

## Hot-reload — AGENTS.md without agent restart

When a workflow or role assignment changes, managed agents get their AGENTS.md regenerated automatically — **without stopping the tmux session**.

### Trigger events

| Event | Published by | Stream |
|-------|-------------|--------|
| `workflow.updated` | `updateWorkflow()` in workflow-loader.ts | `konoha:agent-reload` |
| `role.assigned` | `updateRole()` in runtime.ts (when `assignees` changes) | `konoha:agent-reload` |

### Reload loop

`startAgentHotReload()` in `server.ts` runs a consumer group reader on `konoha:agent-reload`:

1. Receives a `workflow.updated` or `role.assigned` entry
2. Lists all managed agents via `listAgentDefs()`
3. For each agent whose working directory has a `AGENTS.md`: calls `buildSystemPrompt()` and overwrites the file
4. Logs: `[hot-reload] Regenerated AGENTS.md for agent "{id}" ({event type})`

**The agent's tmux session is not restarted.** The new AGENTS.md takes effect on the agent's next session cycle (`/new` every 2 hours via `naruto:session-cleanup`).

---

## tmux session naming

Every managed agent uses an isolated tmux socket and session named exactly as the agent id:

```bash
tmux -L {agent_id} has-session -t {agent_id}
tmux -L {agent_id} capture-pane -pt {agent_id}
```

The old `konoha-{agent_id}` session naming is retired. `tmux_session_override` remains in the API for compatibility/status display only; process management uses `src/agent/process.ts`.

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
