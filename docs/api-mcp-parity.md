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
- `Legacy bounded` — compatibility only, with a documented sunset and regression guard.

| Domain | HTTP surface | MCP surface | Action surface | Status | Follow-up |
|---|---|---|---|---|---|
| Workflow definitions | `/workflows` compatibility wrappers | `konoha_workflow_list/get/create/update` behind `process-tools` | `workflow.create/update/delete/list/get`, plus element/flow/trigger actions | Canonical action executor for HTTP and `/act`; MCP still HTTP-wrapper | #591: eEPC regression suite |
| Workflow elements/flow/triggers | Coarse workflow update via `/workflows`; `element.*`, `flow.*`, and `trigger.*` via `/act`; trigger resolver routes | Generic `konoha_action_*` bridge for implemented actions; no bespoke fine-grained MCP tools | `element.add/update/remove`, `flow.add/remove`, `trigger.set/resolve` direct | Canonical fine-grained action executor; MCP uses generic action bridge | #590 follow-up only if bespoke MCP fine-grained editing tools are needed |
| Cases | `/cases` routes, `/workflows/:id/cases` active listing | `konoha_case_list/start/get`; generic `konoha_action_*` for implemented actions | `case.start/get/list/close/cancel/delete`, `event.confirm`, `event.waiting.list` | Canonical executor for start/close/cancel/delete/list/get; MCP still has partial bespoke HTTP wrappers | Runtime semantics covered by regression suite; add bespoke MCP wrappers only for stable agent workflows |
| Work items | `/workitems` routes | `konoha_workitem_list/complete`, `konoha_complete_task` | `workitem.create/update/list/complete/cancel` | Canonical executor for create/update/complete/cancel/list; MCP still HTTP-wrapper | Convert MCP tools to action wrappers when agent workflows need receipts |
| Roles | `/roles` CRUD | `konoha_role_list`, `konoha_role_assign` | `role.create/list/update/delete` | Canonical executor for CRUD; MCP still HTTP-wrapper | Convert MCP tools to action wrappers when agent workflows need receipts |
| Agents lifecycle | `/agents`, `/agents/:id/start/stop/restart/switch-runtime`, profile routes | Bus tools: `konoha_register`, `konoha_agents`, `konoha_heartbeat`; no lifecycle MCP tools | `agent.register/start/stop/restart` | Canonical executor for start/stop/restart; register remains invite-compatible bus registration | See `docs/entity-contracts.md`; lifecycle MCP deferred until auth/rollback semantics are explicit |
| Messages / bus | `/messages` send/read/pending/ack/history/stream | `konoha_send/read/listen/history/channels` | `message.send/read` | Partial | Keep bus as operational substrate; do not overload `/act` for streaming reads |
| Reminders | `/reminders` routes; BullMQ/runtime worker | No MCP tools | `reminder.create/list/update_status/delete` | Canonical executor for CRUD | Add MCP tools only if agents need direct reminder control |
| Documents | `/documents` CRUD | No MCP tools | No document actions yet | Contracted gap | See `docs/entity-contracts.md`; add action IDs before MCP mutation tools |
| Skills | `/skills` CRUD | `konoha_skill_list` only | No skill actions yet | Partial | Treat as admin/config until Workflow Engine requires mutation through agents |
| Events / subscriptions | `/events`, `/event-manager/*`, webhooks | `konoha_event_emit` | `event.subscribe/cancel/confirm/waiting.list`, plus runtime calls | Partial | #592: harden waits/joins/idempotency before expanding MCP |
| KB / files / artifacts | `/kb/*`, `/workspace/*` | No MCP wrappers | `file.read`, `search.query` only | Contracted partial | See `docs/entity-contracts.md`; filesystem vs DB ownership is explicit per artifact type |
| People / whitelist | `/people`, `/whitelist` | No MCP wrappers | No action contracts | Gap | Keep admin-only unless workflow assignment requires agent-visible control |
| AI chat / Tsunade | `/ai/chat` canonical; `/tsunade/chat` and `/ai/process-chat` retired | No MCP wrappers | Uses workflow action receipts internally | Canonical | See `docs/legacy-retirement.md` |
| Deployment/config/admin | `/deploy`, `/config`, `/admin`, `/setup` | No MCP wrappers | `github.issue.create`, audit actions only | Partial | Keep out of Workflow Engine core unless operational workflows need it |
| Testbench | Testbench HTTP API | `konoha_testbench_*` | No action contracts | Canonical for tests | Keep as testing surface, not product API |

## Immediate Decisions

- Workflow definition mutations now converge on the action executor from `/act` and `/workflows`; `element.add/update/remove`, `flow.add/remove`, and `trigger.set/resolve` use direct action executors. MCP workflow tools are still HTTP wrappers or generic action bridge calls and should become action wrappers when the MCP surface is revised.
- Case start/close and work item create/update/complete/cancel HTTP routes now call the same direct action executor as `/act`; legacy routes remain compatibility wrappers without adding separate audit entries.
- Role and reminder HTTP CRUD routes now also call the direct action executor; `reminder.update_status` is classified as a mutating action.
- Agent lifecycle start/stop/restart routes now call direct action executor handlers. `agent.register` deliberately remains an invite-compatible bus registration endpoint, not a managed lifecycle mutation.
- MCP parity should not mean “every route becomes a tool”. Agent-facing tools should cover stable, useful operations; admin-only surfaces can remain HTTP-only.
- Runtime semantics come before broader tool exposure. Waits, joins, subprocesses, retries, and idempotency need tests before more agents can safely drive them.
- Legacy chat routes should remain compatibility shims only. New UI/API/MCP work should target `/api/ai/chat`, `/act`, and typed action receipts.

## Coverage Gaps To Track

- #589 — make `/act` the primary executor for workflow core actions. Closed for workflow definitions and `element.add`/`flow.add`/`flow.remove`; remaining element/trigger/runtime operations are scoped follow-ups.
- #591 — deterministic eEPC state-machine regression suite. Closed; suite is in preflight.
- #592 — harden waits, joins, subprocesses, retries, and idempotency. Closed for current runtime boundary issues.
- #593 — persistence/API/MCP contracts for artifacts, roles, reminders, and agents. Closed by `docs/entity-contracts.md`.
- #594 — old Tsunade/process-chat paths are retired; contract tests expect 404.
