# Konoha Architecture

Konoha is a multi-agent control plane for Telegram-facing assistants, coding agents, and Workflow Engine operators. It combines a Bun/Hono HTTP API, MCP tools, Redis streams, PostgreSQL shadow persistence, systemd-supervised agent runtimes, and a React dashboard.

This document is the high-level map. Entity-level ownership rules live in `docs/entity-contracts.md`; agent startup/runtime details live in `docs/agent-lifecycle.md`; watchdog delivery details live in `docs/watchdog-architecture.md`.

The target product architecture is intentionally workflow-first and keeps the
mandatory system-agent footprint small. See `docs/adr-004-minimal-system-agents.md`.

## Current Shape

```text
UI / HTTP / MCP / agents
        |
        v
core/src/server.ts  (Hono composition root)
        |
        +-- src/routes/*                 API surfaces
        +-- src/act-envelope.ts          typed action envelope
        +-- modules/workflow-engine/src  workflow/case/work-item routes
        +-- src/redis.ts                 bus facade + Redis stream operations
        +-- src/storage/pg*.ts           PostgreSQL shadow/presence storage
        +-- src/agent-lifecycle.ts       managed agent definitions/runtime state
```

The production server is started through `bun run start`, which resolves to `core/src/server.ts`.

## Component Boundaries

### HTTP Composition Root

- File: `core/src/server.ts`
- Runtime: Bun + Hono
- Production port: `KONOHA_PORT=3200`
- Local/default port: `3100`
- Auth: Bearer token middleware from `src/middleware/auth.ts`
- Responsibility: mount routes, initialize schedulers/listeners, and keep the composition layer thin.

Domain logic should stay under `src/*` or `modules/*`, not in the composition root.

### Action Spine

- Files: `src/act-envelope.ts`, `src/action-registry.ts`, `src/action-executor.ts`, `src/action-handlers.ts`
- Canonical direction: UI, HTTP wrappers, MCP tools, and agents should converge on typed action contracts.
- `/act` is the public action envelope.
- Legacy HTTP routes may remain as wrappers, but should not fork mutation logic.

Target shape:

```text
UI / HTTP / MCP / agents
        -> validated action contract
        -> one executor path
        -> storage/runtime side effects
```

See `docs/api-mcp-parity.md` for the current parity matrix.

### Agent Lifecycle

- Owner: `src/agent-lifecycle.ts`
- Agent definitions: split Redis model (`konoha:agent-defs`, `konoha:agent-templates`, `konoha:agent-runtime-configs`)
- Runtime state: Redis hash `konoha:agent-states`
- Lifecycle audit: Redis stream `konoha:agent-audit`
- Control plane: `/agents/:id/start|stop|restart|switch-runtime`

Permanent agents are supervised by systemd wrappers that call lifecycle API routes. Manual tmux edits are not the control plane.

Long-term rule: durable system agents are exceptional. The required product
core is `Советник` and, where needed, `Системный монитор`. Development workers,
knowledge curators, messenger responders, and external operator aliases should
be optional runtime workers assigned by workflow roles rather than hardcoded as
the product model.

### Agent Presence And Bus

- Owner: `src/redis.ts` facade plus `src/storage/pg-bus.ts`
- Presence/history: PostgreSQL table `konoha_agents`
- Legacy compatibility: Redis hash `konoha:registry`
- Direct messages: Redis streams `konoha:agent:{id}`
- Bus audit stream: Redis stream `konoha:bus`
- Channels: Redis streams `konoha:channel:{name}`
- Push notifications: Redis pub/sub `konoha:notify:{id}`

Important distinction: `AgentDef` is durable managed-agent configuration. Bus presence is online/offline history. Presence must not overwrite managed definitions.

External bus clients are a user/operator scenario, not a reason to seed more
system agents. They should authenticate, appear as runtime actors, and receive
work through roles or explicit messages.

### Channel Connectors

Messenger accounts, bots, user sessions, CRM webhooks, GitHub webhooks, and
similar adapters are information-system connectors. They should ingest events,
emit normalized workflow events, and send outbound messages on request. They
should not own business logic hidden in a long-lived agent prompt.

Target message-processing shape:

```text
connector event -> classifier/router -> workflow event -> role-assigned function
```

This lets many workflows share one account and one workflow use many accounts or
messengers.

### Workflow Runtime Storage

Workflow Engine entities are still Redis-primary unless a contract explicitly says otherwise:

- Workflows, cases, work items, roles, reminders, documents: Redis active store.
- PostgreSQL: shadow durability and analytics store.
- `PG_READ=false`: current production default.
- `PG_READ=true`: future cutover mode, gated by `docs/workflow-engine.md` and the persistence roadmap.

`scripts/pg-verify.ts` is the current safety check: every active Redis entity must exist in PostgreSQL. `onlyInRedis` is a release/cutover blocker. Extra PostgreSQL rows are treated as archived/historical retention debt; as of 2026-04-30 production has `onlyInRedis=0` and known `onlyInPG` bloat, so `PG_READ=true` must stay gated until retention filtering/cleanup is designed.

### MCP Surface

- File: `src/mcp.ts`
- Purpose: expose Konoha operations to Claude Code, Codex, Cursor, and other MCP-capable agents.
- Current stance: MCP parity means useful agent-facing operations, not automatic exposure of every admin route.
- Workflow MCP tools are currently wrappers; new mutation work should prefer action contracts first.

### LLM Client Profiles

- Files: `src/agent/llm-client-profiles.ts`, `src/agent/runtime.ts`, `scripts/claude-provider.sh`
- Preferred fields: `llm_client_profile`, `fallback_llm_client_profile`
- Legacy compatibility fields: `runtime`, `model`, `fallback_runtime`, `reasoning_effort`

The active persistent fleet uses Claude Code runtime adapters backed by DeepSeek profiles. Codex/GPT fallback is configured as an explicit profile and verified by healthcheck when the proxy path is available.

See `docs/adr-003-agent-runtime-provider.md`.

### Watchdogs

Active watchdogs are delivery adapters, not lifecycle owners:

- Dedicated wrappers: `watchdog-naruto.py`, `watchdog-sasuke.py`, `watchdog-kakashi.py`, `watchdog-kiba.py`
- Shared single-agent library: `watchdog_base.py`
- Generic multi-agent lifecycle watcher: `watchdog-lifecycle.py`
- Legacy reference fallback: `watchdog.py`

`scripts/healthcheck-system.py` verifies that active systemd units use the expected lifecycle/watchdog entrypoints.

## Message Flow

### Direct Message

```text
POST /messages {to: "agentB"}
  -> Redis stream konoha:agent:agentB
  -> Redis pub/sub konoha:notify:agentB
  -> Redis stream konoha:bus
  -> PostgreSQL shadow row in konoha_messages
```

### Broadcast

```text
POST /messages {to: "all"}
  -> list online agents from presence
  -> fan out to each recipient stream
  -> write bus audit and PostgreSQL shadow rows
```

### Role Routing

```text
POST /messages {to: "role:monitor"}
  -> resolve online agents with role "monitor"
  -> fan out to matching agent streams
  -> write bus audit and PostgreSQL shadow rows
```

## Delivery Semantics

- Redis streams provide at-least-once delivery.
- Each agent stream has a consumer group.
- `GET /messages/:agentId` reads and ACKs.
- History reads are non-destructive.
- Telegram stream lag/pending and dead-letter streams are checked by `scripts/healthcheck-system.py` and `scripts/telegram-smoke.sh`.

## Deployment

### Production Service

```ini
# /etc/systemd/system/konoha.service
[Unit]
Description=Konoha Bus
After=redis-server.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/konoha
ExecStart=/home/ubuntu/.bun/bin/bun run start
Environment=KONOHA_PORT=3200
EnvironmentFile=/home/ubuntu/.agent-env
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Local Bus

```bash
bun install
KONOHA_TOKEN=your-secret KONOHA_PORT=3200 bun run start
```

### MCP Client Configuration

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

## Operational Gates

Production hardening is enforced by `scripts/preflight.sh`:

- system health: services, lifecycle wrappers, watchdogs, Telegram streams, source size, LLM profiles
- backend typecheck
- backend regression tests
- frontend typecheck/build
- Telegram smoke
- PostgreSQL shadow verification
- BPMS load regression profile validation and release-gate report attachment
- data-store backup/restore drill contract and staging restore report

Current rule before larger Workflow Engine changes: run production preflight and review all non-zero checks before release. Known exception as of 2026-04-30: PostgreSQL shadow verification can return bloat-only exit code `2` even when sync is complete (`onlyInRedis=0`); treat that as retention debt, not a code regression, until the retention policy is implemented. CI runs the portable companion gate (`scripts/preflight-portable.sh`): the same typechecks/regression suites plus frontend tests/build, without production-only systemd, Telegram smoke, or live credential dependencies. Broad BPMS refactors and the #753 staging rollout are additionally blocked by `docs/lean-baseline-gate.md` until the lean `prod-core` baseline is measured clean or Naruto records a time-boxed waiver.

## Key Design Rules

- Workflow before agent: deterministic business flows should live in Workflow Engine, not hidden in agent prompts.
- Agent lifecycle through API: no manual tmux/systemd business logic.
- One mutation path: action contracts first, wrappers second.
- Connectors are information systems; business behavior belongs in workflows.
- Credentials are scoped connector/secret references, not raw workflow documents.
- Redis-primary workflow runtime until `PG_READ=true` cutover criteria are met.
- MCP tools expose stable agent-useful capabilities, not every admin endpoint.
- Legacy compatibility surfaces are bounded by `docs/legacy-retirement.md`.
