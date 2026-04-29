# Entity Contracts

This document fixes ownership boundaries for the entities that Workflow Engine, agents, API, and MCP all touch. It is the default reference before adding new routes, actions, or MCP tools.

## Contract Rules

- Every write path must name one owner module. Other surfaces are wrappers.
- Redis remains the Phase 1 active store unless the entity explicitly says otherwise.
- PostgreSQL shadow rows are durability/analytics support, not the read source while `PG_READ=false`.
- MCP parity means agent-useful operations, not automatic exposure of every admin route.
- Runtime-generated entities must be idempotent or deduplicated by a stable key.

## Roles

Owner: `src/runtime/roles.ts`

Storage:
- Redis active store: `role:{id}`, `konoha:roles:all`.
- PostgreSQL shadow: `roles`.
- Workflow reverse index: `konoha:role:{roleId}:workflows`, maintained by `workflow-loader` and schema registry sync.

API/MCP/action:
- HTTP: `/roles` CRUD.
- MCP: `konoha_role_list`, `konoha_role_assign`.
- Actions: `role.create`, `role.list`, `role.update`, `role.delete`.

Lifecycle:
- Workflow save can auto-create skeleton roles referenced by function elements.
- Workflow archive removes workflow references but does not delete role definitions.
- Role assignment changes should trigger agent prompt regeneration through lifecycle reload events.

Rules:
- Role definitions are business entities, not agent presence records.
- `role.assignees[]` is the canonical human/agent assignment list.
- Deleting a role should be explicit; orphan detection may warn but must not auto-delete.

## Reminders

Owner: `src/runtime/reminders.ts`

Storage:
- Redis active store: `reminder:{id}`, `konoha:reminders:all`, `konoha:reminders:status:{status}`.
- PostgreSQL shadow: `reminders`.
- BullMQ queue: `reminder-scheduler`, job id equals `reminder_id`.

API/MCP/action:
- HTTP: `/reminders` list/create/status/delete.
- MCP: intentionally absent for now.
- Actions: `reminder.create`, `reminder.list`, `reminder.update_status`, `reminder.delete`.

Lifecycle:
- Standalone reminders are user/agent scheduling objects.
- Process-bound reminders are notification side effects for waits/work items.
- Firing a reminder sends notification only; it must never advance a case or complete a work item.
- Deleting a reminder must remove Redis state and the BullMQ job.

Rules:
- Runtime wait reminders must be deduplicated by the wait/reminder owner path, not by Telegram delivery.
- Reminder status is operational state; case state remains owned by `runtime/cases`.
- MCP reminder tools should be added only if agents need direct reminder management.

## Agents

Owner: `src/agent-lifecycle.ts` for definitions/runtime state; `src/redis.ts` and `src/storage/pg-bus.ts` for bus presence/messages.

Storage:
- Agent definitions: split Redis model (`konoha:agent-defs`, templates/runtime configs) with legacy compatibility projection.
- Runtime state: `konoha:agent-states`.
- Lifecycle audit: `konoha:agent-audit`.
- Presence registry: bus registry and PostgreSQL shadow `konoha_agents`.
- Messages: Redis per-agent streams `konoha:agent:{id}` and PostgreSQL shadow `konoha_messages`.

API/MCP/action:
- HTTP: `/agents`, lifecycle routes, profiles, memory, tmux/status.
- MCP: bus tools `konoha_register`, `konoha_agents`, `konoha_heartbeat`; no lifecycle MCP tools yet.
- Actions: `agent.register`, `agent.start`, `agent.stop`, `agent.restart`.

Lifecycle:
- Permanent agents are supervised by systemd wrappers that call the lifecycle API.
- On-demand agents are started/stopped through lifecycle routes.
- Runtime/provider changes are AgentDef changes plus restart; no manual tmux edits.
- Bus registration is presence, not durable definition ownership.

Rules:
- `AgentDef` is source of truth for managed agent identity and runtime config.
- `konoha:registry`/`konoha_agents` is presence/history and must not overwrite AgentDef.
- Protected system agents cannot be deleted through normal API.
- MCP lifecycle tools are deferred until lifecycle authorization and rollback semantics are explicit.

## Documents And Artifacts

Owners:
- Document templates: `src/runtime/documents.ts`.
- Knowledge base files: `src/routes/kb.ts` and filesystem KB directory.
- Workspace/uploads/attachments: `src/routes/avatars.ts`, Telegram attachment pipeline, and shared filesystem paths.
- Workflow artifacts embedded in process schemas: `workflow-loader` and schema registry sync.

Storage:
- Documents active store: `doc:{id}`, `konoha:docs:all`.
- Documents PostgreSQL shadow: `documents`.
- KB/artifacts filesystem: repository or `/opt/shared/...` paths depending on source.
- Attachments: `/opt/shared/attachments/`.

API/MCP/action:
- HTTP: `/documents`, `/kb/*`, `/workspace/*`, attachment/avatar routes.
- MCP: no general artifact/document mutation tools yet.
- Actions: `file.read`, `search.query`; no document CRUD actions yet.

Lifecycle:
- Documents referenced by workflow functions are metadata inputs for dispatch/prompt context.
- KB files are knowledge source material, not workflow state.
- Attachments are immutable shared files once downloaded/uploaded; metadata may be carried in messages or workflow payloads.

Rules:
- Do not mix KB filesystem ownership with document template CRUD without an explicit migration.
- New document/artifact mutation through agents requires action IDs first, then MCP wrappers.
- Filesystem paths exposed to agents must be allowlisted/shared paths, never arbitrary host paths.

## Waits And Runtime Events

Owner: `src/runtime/cases/*` and `src/runtime/event-waits/*`

Storage:
- Cases/work items active store: Redis case/workitem keys and indices.
- Event waits: `event-wait:{id}`, `konoha:event-waits:*`.
- PostgreSQL shadow: `cases`, `work_items`.

API/MCP/action:
- HTTP: `/cases`, `/workitems`, wait/event routes.
- MCP: case/workitem list/start/get/complete and `konoha_event_emit`.
- Actions: `case.*`, `workitem.*`, `event.confirm`, `event.waiting.list`.

Lifecycle:
- Cases are created by explicit start, event subscription, or subprocess call.
- Work items pause case advancement until completion unless a system adapter completes them inline.
- Event waits pause only explicit wait-boundary events; terminal/pass-through events must not create waits.
- Idempotency keys suppress duplicate event deliveries.

Rules:
- Runtime code owns case state transitions; reminders and Telegram messages are notifications only.
- Joins resume only after all active branches are done.
- Subprocess parent work items are completed only by child case completion.
