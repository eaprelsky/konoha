# API / MCP / Action Parity Matrix

This matrix is the working map for closing UI/API/MCP duplication before deeper Workflow Engine work. The target architecture is:

```text
UI / HTTP / MCP / agents
        -> validated action contract
        -> one executor path
        -> storage/runtime side effects
```

Current status legend:

- `Canonical` — this surface is the preferred path for new work.
- `Wrapper` — usable, but should call the canonical path instead of duplicating logic.
- `Partial` — useful coverage exists, but not full CRUD/lifecycle parity.
- `Gap` — missing or not wired to the target architecture.
- `Legacy` — compatibility only; do not extend.

| Domain | HTTP surface | MCP surface | Action surface | Status | Follow-up |
|---|---|---|---|---|---|
| Workflow definitions | `/workflows` compatibility wrappers | `konoha_workflow_list/get/create/update` behind `process-tools` | `workflow.create/update/delete/list/get`, plus element/flow/trigger actions | Canonical action executor for HTTP and `/act`; MCP still HTTP-wrapper | #591: eEPC regression suite |
| Workflow elements/flow/triggers | Coarse workflow update via `/workflows`; trigger resolver routes | No fine-grained MCP tools | `element.add/update/remove`, `flow.add/remove`, `trigger.resolve/subscribe/cancel` | Gap | #589: promote action executor; #590 follow-up if MCP fine-grained editing is needed |
| Cases | `/cases` routes | `konoha_case_list/start/get` | `case.start/get/list/close`, `event.confirm`, `event.waiting.list` | Partial | #592: runtime hardening; add MCP wrappers only after semantics are stable |
| Work items | `/workitems` routes | `konoha_workitem_list/complete`, `konoha_complete_task` | `workitem.create/update/list/complete/cancel` | Partial | #589: unify completion path through validated action contracts |
| Roles | `/roles` CRUD | `konoha_role_list`, `konoha_role_assign` | `role.create/list/update/delete` | Partial | #593: define role persistence/API/MCP contract |
| Agents lifecycle | `/agents`, `/agents/:id/start/stop/restart/switch-runtime`, profile routes | Bus tools: `konoha_register`, `konoha_agents`, `konoha_heartbeat`; no lifecycle MCP tools | `agent.register/start/stop/restart` | Partial | #593: lifecycle contract; consider MCP lifecycle tools after contract is stable |
| Messages / bus | `/messages` send/read/pending/ack/history/stream | `konoha_send/read/listen/history/channels` | `message.send/read` | Partial | Keep bus as operational substrate; do not overload `/act` for streaming reads |
| Reminders | `/reminders` routes if mounted; BullMQ/runtime worker | No MCP tools | `reminder.create/list/update_status/delete` | Gap | #593: persistence/API/MCP contract, then add MCP wrappers if agents need direct reminder control |
| Documents | `/documents` CRUD | No MCP tools | No document actions yet | Gap | #593: define document/artifact contract before adding action IDs |
| Skills | `/skills` CRUD | `konoha_skill_list` only | No skill actions yet | Partial | Treat as admin/config until Workflow Engine requires mutation through agents |
| Events / subscriptions | `/events`, `/event-manager/*`, webhooks | `konoha_event_emit` | `event.subscribe/cancel/confirm/waiting.list`, plus runtime calls | Partial | #592: harden waits/joins/idempotency before expanding MCP |
| KB / files / artifacts | `/kb/*`, `/workspace/*` | No MCP wrappers | `file.read`, `search.query` only | Partial | #593: artifact contract; decide filesystem vs DB ownership |
| People / whitelist | `/people`, `/whitelist` | No MCP wrappers | No action contracts | Gap | Keep admin-only unless workflow assignment requires agent-visible control |
| AI chat / Tsunade | `/ai/chat` canonical; `/tsunade/chat`, `/ai/process-chat` deprecated | No MCP wrappers | Uses workflow action receipts internally | Legacy/Partial | #594: bound and retire old chat paths |
| Deployment/config/admin | `/deploy`, `/config`, `/admin`, `/setup` | No MCP wrappers | `github.issue.create`, audit actions only | Partial | Keep out of Workflow Engine core unless operational workflows need it |
| Testbench | Testbench HTTP API | `konoha_testbench_*` | No action contracts | Canonical for tests | Keep as testing surface, not product API |

## Immediate Decisions

- Workflow definition mutations now converge on the action executor from `/act` and `/workflows`; MCP workflow tools are still HTTP wrappers and should become action wrappers when the MCP surface is revised.
- MCP parity should not mean “every route becomes a tool”. Agent-facing tools should cover stable, useful operations; admin-only surfaces can remain HTTP-only.
- Runtime semantics come before broader tool exposure. Waits, joins, subprocesses, retries, and idempotency need tests before more agents can safely drive them.
- Legacy chat routes should remain compatibility shims only. New UI/API/MCP work should target `/api/ai/chat`, `/act`, and typed action receipts.

## Coverage Gaps To Track

- #589 — make `/act` the primary executor for workflow core actions. Closed for workflow definitions; element/flow/runtime operations remain scoped follow-ups.
- #591 — deterministic eEPC state-machine regression suite.
- #592 — harden waits, joins, subprocesses, retries, and idempotency.
- #593 — persistence/API/MCP contracts for artifacts, roles, reminders, and agents.
- #594 — retire or bound old Tsunade/process-chat paths and stale docs.
