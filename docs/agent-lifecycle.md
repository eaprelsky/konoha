# Agent Lifecycle — Technical Reference

`src/agent-lifecycle.ts`

The agent lifecycle module manages two separate concerns:

- **Persistent definitions** — what an agent is (name, model, skills, system prompt)
- **Runtime state** — whether the agent is running, in which tmux session, since when

Both are stored in Redis and survive server restarts.

The public `/agents` API is backward-compatible and still returns flattened fields, but internally new code should use explicit projections:

| Boundary | Source | Meaning |
|----------|--------|---------|
| `AgentTemplate` | `AgentDef` | Durable identity and human-editable instructions |
| `AgentRuntimeConfig` | `AgentDef` | Launch adapter, model profile, MCP/tool config, tmux hints |
| `AgentPresence` | Konoha bus heartbeat registry | Online/offline presence and last heartbeat |
| `AgentRuntimeState` | lifecycle manager/tmux/systemd | Process state, pid, uptime, startup errors |
| `AgentView` | projection | Backward-compatible API view with structured boundaries |

Use `composeAgentView()` for `/agents` responses instead of ad hoc object spreading. This keeps old clients working while the storage model is split.

See `docs/agent-naming.md` for the canonical split between runtime `id`, portable
corporate `name`, mutable `display_alias`, workflow roles, and assignment
policies.

---

## Data model

### AgentDef (persistent definition)

```ts
interface AgentDef {
  id: string;                         // unique agent ID (e.g. "naruto", "kakashi")
  name: string;                       // canonical portable product/corporate name
  display_alias?: string;             // mutable tenant-local callsign/persona alias
  runtime?: 'claude' | 'codex' | 'cursor' | 'glm';
  fallback_runtime?: 'claude' | 'codex' | 'cursor' | 'glm';
  llm_client_profile?: string;          // preferred: runtime adapter + provider + model profile
  fallback_llm_client_profile?: string;
  tool_profile?: string;                // preferred: MCP/tool access boundary profile
  sandbox_profile?: string;             // execution isolation profile, current default: "tmux"
  model: string;                      // provider-qualified model ID (e.g. "claude:sonnet", "codex:gpt-5.5")
  reasoning_effort?: string;          // provider-specific effort, e.g. "high" for Codex
  system_prompt?: string;             // user-editable instructions (appended after system template)
  env?: Record<string, string>;       // custom env vars for this agent's process
  tags?: string[];                    // labels (e.g. ["system"])
  seed_classification?:               // ADR-004 seed/runtime classification
    | "core"
    | "optional_worker"
    | "connector_owned"
    | "deprecated_compat"
    | "out_of_scope";
  lifecycle_mode?:                    // product-facing lifecycle mode
    | "core"
    | "optional_on_demand"
    | "connector_owned"
    | "deprecated";
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
  - Agent identity (id, canonical name, display alias, model)
  - Startup sequence (source /home/ubuntu/.agent-env, read MEMORY.md, konoha_register with name and display_alias, wait for tasks)
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

### Tool Profiles

`tool_profile` is the preferred way to describe shared MCP access. It is separate from `capabilities[]`:

- `capabilities[]` describes skills/roles that shape the system prompt and may add skill-local MCP servers.
- `tool_profile` describes shared MCP boundaries such as `telegram-userbot`, `diagnostics`, `business-ops`, or `knowledge-readwrite`.
- `shared_mcp_allowlist` is still supported and takes precedence over `tool_profile` for backward compatibility.

Available profiles are exposed by:

```bash
curl -H "Authorization: Bearer $KONOHA_TOKEN" \
  http://127.0.0.1:3200/agents/tool-profiles
```

To add a tool profile safely:

1. Add it in `src/agent/tool-profiles.ts` with explicit `mcp_servers`, `scopes`, and `dangerous_tools` if applicable.
2. Prefer least privilege: do not use the `full` profile for new agents unless there is a written reason.
3. Add or update a test in `tests/tool-profiles.test.ts`.
4. Restart affected agents so `.mcp.json` is regenerated.

### Sandbox Profiles

`sandbox_profile` is separate from the LLM client and runtime adapter. Current production agents use `tmux`: isolated tmux socket/session named after the agent id, supervised through systemd and lifecycle API. `process`, `docker`, and `remote` are documented profiles for future migration, not active defaults.

Move an agent to Docker/remote only when a tool profile requires stronger filesystem/network isolation than tmux/process can provide, and after adding lifecycle healthchecks for that sandbox type.

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

Returns the fully rendered AGENTS.md content for a given agent, including base
identity/startup text, user instructions, role blocks, and skill snippets.

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3200/agents/kakashi/system-template
```

---

## Seeded compatibility definitions

`seedSystemAgents()` still writes protected definitions for compatibility, but
ADR-004 narrows the required product core to `tsunade` / `Советник` and optional
`kiba` / `Системный монитор`. The seed metadata now makes the lifecycle mode
explicit:

| Runtime id | Product-facing role | `seed_classification` | `lifecycle_mode` | Autostart expectation |
|------------|---------------------|------------------------|------------------|----------------------|
| `naruto` | Telegram bot connector | `connector_owned` | `connector_owned` | connector deployment only |
| `sasuke` | Telegram user-account connector | `connector_owned` | `connector_owned` | connector deployment only |
| `kiba` | Системный монитор | `optional_worker` | `optional_on_demand` | optional, enabled on deployments that need active monitoring |
| `kakashi`, `guy`, `shino`, `hinata` | SDD workflow workers | `optional_worker` | `optional_on_demand` | no; started by assignment/policy |
| `mirai` | External-source connector compatibility actor | `connector_owned` | `connector_owned` | no default autostart |
| `shikadai` | architecture decomposition worker | `optional_worker` | `optional_on_demand` | no; started by assignment/policy |
| `jiraiya`, `ino`, `inojin` | legacy specialist aliases | `deprecated_compat` | `deprecated` | no |
| `ibiki` | optional security worker | `optional_worker` | `optional_on_demand` | no |

Seed is idempotent and can be re-run via `POST /admin/seed-system-agents`.
Existing runtime ids, tmux sessions, and systemd unit names remain stable until
#620.

When seed runs over an existing definition, structural/runtime metadata is
refreshed from code, but org-owned display fields are preserved: `name`,
`display_alias`, and `avatar_url`. This lets migrations add
`seed_classification`, `lifecycle_mode`, profiles, tags, and capabilities
without clobbering local product labels or callsigns.

Kakashi is seeded as a protected optional worker but must not autostart. Keep
`agent-kakashi.service` and `agent-watchdog-kakashi.service` disabled unless an
operator explicitly starts him for a delegated task.
