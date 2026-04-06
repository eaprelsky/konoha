# Skills — Technical Reference

Skills (capabilities) are reusable packages that extend an agent with new tools or behaviors. Each skill can contribute:

- A **prompt snippet** — instructions injected into the agent's CLAUDE.md at startup
- **MCP server definitions** — additional tool servers added to the agent's `.mcp.json`

---

## Data model

```ts
type SkillRecord = {
  id: string;               // slug (auto-generated from name if not set)
  name: string;             // display name (Russian)
  name_en?: string;         // English name (optional)
  description?: string;     // short description
  prompt_snippet?: string;  // injected into CLAUDE.md under "## Skill: {name}"
  tools?: string[];         // list of tool names this skill uses (informational)
  mcp_servers?: McpServerDef[];  // MCP servers to add to .mcp.json
  created_at: string;
  updated_at: string;
};

type McpServerDef = {
  name: string;       // key in mcpServers config
  command: string;    // executable (supports ${VAR} env refs)
  args?: string[];    // command arguments
  env?: Record<string, string>;  // environment variables (support ${VAR} refs)
};
```

Stored in Redis: `konoha:skill:{id}` (JSON), indexed in sorted set `konoha:skills:all`.

---

## How skills are applied

When an agent is started, `startAgent()` reads all skills listed in `AgentDef.capabilities`:

### 1. Prompt snippets → CLAUDE.md

For each skill with a non-empty `prompt_snippet`, the following block is appended to the agent's CLAUDE.md:

```
## Skill: {skill.name}
{skill.prompt_snippet}
```

This means skills can define how the agent should behave, what commands it knows, and what it should do when triggered.

### 2. MCP servers → .mcp.json

Each skill's `mcp_servers` entries are merged into the agent's `.mcp.json`. Environment variable references are resolved from `/opt/konoha/.env.global` and the agent's own `env` map.

Example skill with MCP server:
```json
{
  "id": "yandex-tracker",
  "name": "Яндекс Трекер",
  "mcp_servers": [
    {
      "name": "tracker",
      "command": "/home/ubuntu/.bun/bin/bun",
      "args": ["run", "/home/ubuntu/tracker-mcp/index.ts"],
      "env": {
        "TRACKER_TOKEN": "${TRACKER_TOKEN}",
        "TRACKER_ORG": "${TRACKER_ORG}"
      }
    }
  ]
}
```

Result in agent's `.mcp.json`:
```json
{
  "mcpServers": {
    "konoha": { ... },
    "tracker": {
      "command": "/home/ubuntu/.bun/bin/bun",
      "args": ["run", "/home/ubuntu/tracker-mcp/index.ts"],
      "env": {"TRACKER_TOKEN": "real-value", "TRACKER_ORG": "real-value"}
    }
  }
}
```

### 3. Changes take effect on restart

CLAUDE.md and .mcp.json are regenerated each time the agent starts. Editing a skill or adding/removing a skill from an agent's capabilities takes effect on the **next restart**.

---

## HTTP endpoints

All skill endpoints require authentication (`Bearer $TOKEN`).

### GET /skills

List all skills.

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3200/skills
```

### POST /skills

Create a skill.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Яндекс Трекер",
    "name_en": "Yandex Tracker",
    "description": "Работа с задачами в Яндекс Трекере",
    "prompt_snippet": "## Яндекс Трекер\nИспользуй MCP-инструменты tracker_* для работы с задачами.",
    "mcp_servers": [
      {
        "name": "tracker",
        "command": "/home/ubuntu/.bun/bin/bun",
        "args": ["run", "/home/ubuntu/tracker-mcp/index.ts"],
        "env": {"TRACKER_TOKEN": "${TRACKER_TOKEN}"}
      }
    ]
  }' \
  http://127.0.0.1:3200/skills
```

Response (201):
```json
{
  "id": "яндекс-трекер",
  "name": "Яндекс Трекер",
  ...
}
```

`id` is auto-generated from `name` (lowercase, spaces → dashes, non-alphanumeric removed) unless explicitly provided.

### PATCH /skills/:id

Update skill fields. Only provided fields are changed.

```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt_snippet": "Updated instructions..."}' \
  http://127.0.0.1:3200/skills/яндекс-трекер
```

### DELETE /skills/:id

Delete a skill. Does not remove it from agents that currently have it in `capabilities` — that list is not updated automatically.

```bash
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3200/skills/яндекс-трекер
```

---

## Assigning skills to agents

Skills are assigned in the agent definition's `capabilities` array:

```bash
# When creating/updating an agent
curl -X PUT -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"capabilities": ["yandex-tracker", "bitrix24"]}' \
  http://127.0.0.1:3200/agents/kakashi
```

After updating capabilities, restart the agent for changes to take effect:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3200/agents/kakashi/restart
```

---

## ${VAR} resolution

Variable references in `mcp_servers[].command`, `args[]`, and `env` values are resolved in this order:

1. `/opt/konoha/.env.global` — shared infrastructure credentials
2. `AgentDef.env` — per-agent overrides

References that cannot be resolved remain as-is (e.g. `${MISSING_VAR}`).
