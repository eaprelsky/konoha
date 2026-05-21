# Workflow Engine — Architecture

> Source: `frontend/src` (canonical workflow UI) · `modules/workflow-engine/` (plugin wrappers + runtime module) · `src/runtime/` · `src/dispatcher.ts`
>
> API/MCP/action coverage map: `docs/api-mcp-parity.md`.
> Entity ownership contracts: `docs/entity-contracts.md`.
> Legacy retirement inventory: `docs/legacy-retirement.md`.
> Security and audit boundary: `docs/workflow-security-boundary.md`.
> Preflight tier contract: `docs/workflow-engine-preflight-tiers.md`.
> Runtime rollback and recovery: `docs/workflow-runtime-rollback-recovery.md`.
> Constructor/runtime release checklist: `docs/workflow-constructor-runtime-release-checklist.md`.

## Overview

The Workflow Engine executes business processes modelled as **eEPC diagrams** (event-driven process chains). A process definition consists of:

- **Elements** — events, functions, gateways, documents, information systems, roles
- **Flow** — directed edges `[from, to, condition?]`

At runtime the engine creates a **Case** (instance of a process) and advances it step by step until it reaches a terminal event.

## Frontend Boundary

`frontend/src` is the canonical source of truth for workflow editor UI behavior: editor state, canvas rendering, schema patch application, Tsunade chat panel compatibility, work item UI, and navigation events.

`modules/workflow-engine/frontend` is a plugin boundary. Its editor-facing files are thin re-export wrappers to `@core/...` so the plugin keeps stable route/import paths without maintaining a second copy of workflow UI behavior. New workflow editor behavior must be added to `frontend/src` first; module-local forks are allowed only for genuinely module-specific pages.

## Regression Gate

Before delegating autonomous workflow-engine repair or merging workflow
editor/action changes, select the required tier from
`docs/workflow-engine-preflight-tiers.md`. For a normal production release or
broad runtime change, run the production gate:

```bash
cd /home/ubuntu/konoha
PATH=/home/ubuntu/.bun/bin:$PATH bun run preflight
```

The tier contract separates fast local tests, isolated integration, browser e2e,
staging-core smoke/load evidence, production smoke, `pg-verify`, healthcheck,
and optional specialist QA. The production suite covers:
- `workflow.create` materialization and observable receipts.
- `workflow.patch` durable assistant edits through the server Action Spine boundary, with client-only schema patches treated as preview-only.
- `workflow.open` navigation actions and receipts.
- Confirmation-required `workflow.create` without side effects.
- Deterministic eEPC state-machine semantics: start/end, manual function pause/resume, XOR branch selection, AND split/join, manual waits, event idempotency, and sub-process spawning.
- Wait hardening: terminal events and plain pass-through events do not create `EventWait` rows; active waits are unique per `case_id + element_id`.
- Browser boundary: `AssistantWidget` consumes a canonical `/api/ai/chat` parsed event, applies preview/saved schema patches distinctly, and does not apply failed durable patches.
- Operational boundary: system health, Telegram stream smoke, and Redis/PostgreSQL shadow verification.

---

## Case Lifecycle

```
createCase()
    │
    ▼
advanceCase(case, definition)
    │
    ├─ function element  →  createWorkItem → dispatch → pause (wait for completion)
    ├─ event element     →  update position, subscribe if intermediate trigger
    ├─ gateway XOR/AND/OR →  branch / join logic (see below)
    │
    ▼
completeWorkItem()      (called by agent / adapter)
    │
    ▼
advanceCase()           (resume from completed work item)
    │
    ▼
case.status = "done"    (terminal event) or "error"
```

States: `running` → `done` | `error`

---

## advanceCase Algorithm

`advanceCase(kase, def)` is the core loop in `src/runtime/cases.ts`.

1. **Build adjacency maps** — `outEdges`, `inEdges`, `byId`, `edgeConditions` from the workflow definition. O(n) per call.

2. **Iterate** — starting from `kase.position`, follow the next edge:

   | Next element type | Action |
   |---|---|
   | `function` | Create work item, dispatch it, update `kase.position`, **return** (async pause) |
   | `event` (terminal) | Set `status = "done"`, cancel event subscriptions, **return** |
   | `event` (intermediate with trigger) | Subscribe to trigger, save case, **return** |
   | `event` (intermediate, no trigger) | Pass through, continue loop |
   | `gateway` | See gateway logic below |
   | element not found | Set `status = "error"`, emit `process.exception`, **return** |

3. **System bindings** — if a function element has `systems[]`, the engine calls each adapter synchronously and merges outputs into the case payload. On success the work item is auto-completed and the loop continues without pausing.

---

## Gateway Types

### XOR (exclusive choice / merge)

- **Split**: evaluates edge conditions left-to-right; first match wins. If no condition matches → `status = "error"`.
- **Merge**: pass-through (no synchronisation needed — only one branch was active).

Condition syntax: `payload.<field> <op> <value>` where op ∈ `=== !== > < >= <=`.

### AND (parallel split / synchronise)

- **Split**: all outgoing edges are activated simultaneously. Each branch starts a work item. `kase.active_branches` is populated.
- **Join** (`advancePastJoin`): when **all** branches are `done`, find the join gateway via graph reachability and resume.

### OR (inclusive)

- **Split**: activates branches whose edge condition evaluates to true (or branches with no condition). At least one must match.
- **Join**: same as AND — waits for all activated branches.

---

## Trigger Resolution Flow

Start events can have a trigger that allows automatic case creation:

```
trigger.kind ∈ { "manual", "schedule", "webhook", "telegram", "event", "ambiguous" }
```

1. **Trigger Resolver** (`src/trigger-resolver.ts`) — uses Claude to classify incoming events against known process definitions and populate `trigger.kind` + `confidence`.

2. **Workflow Deployment Service** (`src/workflow-deployment-service.ts`) — `workflow.deploy` validates readiness, commits the executable workflow record and deployed snapshot, computes the start-trigger subscription diff, materializes created/cancelled/unchanged subscriptions, and returns a deploy receipt.

3. **Event Manager** (`src/event-manager.ts`) — manages subscriptions. When an event fires:
   - For `instance_id = "new"` → `createCase()` is called.
   - For an existing `instance_id` → `handleEventFired()` resumes the case at the waiting event node.

4. **`subscribeEventNode`** — called when the engine reaches an intermediate event with a live trigger. Registers a programmatic subscription in the event manager so the case resumes when the trigger fires.

5. **`cancelSubscriptionsByInstance`** — cleans up all active subscriptions when a case terminates (done or error).

---

## Assignment Strategies

`src/dispatcher.ts` resolves where to route a work item when a function element is reached:

| Priority | Strategy | Condition |
|---|---|---|
| 0 | **System agent** | `isSystemRole(role)` — handled by built-in system-agent (timers, doc gen) |
| 1 | **Exact name match** | `agent.id === role \|\| agent.name === role` — dispatches directly to the named agent |
| 2 | **Capability match + load balancing** | `agent.capabilities.includes(role)` — among all matching online agents, picks the one with the fewest in-flight work items |
| 3 | **Person lookup** | Role matches a person in `/opt/shared/.trusted-users.json` or Redis `people:custom` — sends Telegram message |
| 4 | **Manual** | No match — work item stays pending in the Work Items UI |

---

## Event Subscriptions

Subscriptions are stored in Redis and managed by `src/event-manager.ts`:

- `createSubscriptionProgrammatic({ event_id, process_id, instance_id, trigger })` — registers a subscription to resume a waiting case.
- `cancelSubscriptionsByInstance(instance_id)` — removes all subscriptions for a case on termination.
- Adapters (telegram-bot, webhook, schedule, etc.) listen to their source and call the event manager when a matching event arrives.

For deployed start triggers, `workflow.deploy` owns subscription materialization through the workflow deployment service. The transaction order is fixed: validation, executable workflow commit, deployed snapshot save, subscription diff materialization, then persisted deploy receipt. Deploy receipts include a `transaction` object with `transaction_id`, `idempotency_key`, `commit_order`, record keys, and retry policy, plus `deployment_id`, `deploy_version`, and per-event `operation_key`/`idempotency_key` entries for `created`, `cancelled`, `unchanged`, and `failed` subscription operations.

If the snapshot save fails, deployment exits before any subscription side effects. If subscription materialization fails, `workflow.deploy` records a blocked deploy receipt, rolls back created subscriptions where possible, and demotes the workflow back to `validated`/`needs_review`. A retry creates the next deploy transaction/version; matching active subscriptions are treated as `unchanged`, stale duplicates are cancelled by diff, and operation keys remain deterministic as `{workflow_id}:v{deploy_version}:{event_id}`.

---

## PostgreSQL Storage Layer

`src/storage/pg.ts` provides the persistence layer. Redis is used as the primary read/write store; PostgreSQL receives shadow writes for durability and analytics.

The flag `PG_READ=true` switches reads to PostgreSQL (Phase 2 migration, issue #332).

### Tables

| Table | Key | Description |
|---|---|---|
| `workflows` | `id` | Process definitions (elements, flow, triggers) |
| `workflow_snapshots` | `workflow_id, version` | Version history |
| `cases` | `case_id` | Case instances with payload, history, status |
| `work_items` | `id` | Work items with assignee, status, input/output |
| `roles` | `role_id` | Role definitions |
| `documents` | `doc_id` | Document templates |
| `reminders` | `reminder_id` | Scheduled reminders |
| `skills` | `id` | Agent skill definitions |

### Write path

All mutations go through `pgUpsertCase` / `pgUpsertWorkItem` / etc. Most runtime writes are fire-and-forget (`pgWrite`) to avoid blocking the runtime loop on DB latency. Workflow definition writes are awaited by the workflow action executor so `workflow_snapshots` cannot race ahead of their parent `workflows` row.

### Read path

When `PG_READ=true`, `loadCase` / `loadWorkItem` / `listCases` etc. query PostgreSQL instead of Redis. Row converters (`pgRowToCase`, `pgRowToWorkItem`) normalise DB rows to the runtime types.

### Verification gate

Before switching `PG_READ=true` or delegating runtime changes that affect persisted entities, run:

```bash
cd /home/ubuntu/konoha
PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/pg-verify.ts
```

The gate treats Redis as the active source of truth for Phase 1: every active Redis entity must exist in PostgreSQL. Extra PostgreSQL rows are allowed as archived or historical data, but `Only in Redis` means the migration shadow is incomplete. Message verification counts only Redis stream keys under `konoha:agent:*`, so metadata hashes such as agent definitions do not affect the stream check.

If bus entities are out of sync, reconcile them without rotating agent tokens:

```bash
cd /home/ubuntu/konoha
PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/reconcile-pg-bus.ts --dry-run
PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/reconcile-pg-bus.ts
```

The bus reconciler copies `konoha:registry` into `konoha_agents` and per-agent Redis streams into `konoha_messages`. Message inserts are idempotent by `(recipient, stream_id)` and use the recipient implied by the stream key, which preserves broadcast/role fanout history correctly.

### Rollback and recovery

Runtime rollback and recovery procedures live in
`docs/workflow-runtime-rollback-recovery.md`. Redis remains the active runtime
store, PostgreSQL remains shadow evidence until accepted `PG_READ` cutover, and
code rollback does not revert active cases, work items, subscriptions, waits,
reminders, dispatch receipts, or external connector effects. The runbook also
records the #812 terminal-case rule: closed, done, cancelled, error, or
otherwise terminal cases must not receive new work, new tasks, new waits, or
subscription resumes during recovery.

---

## Key Types

```typescript
// src/runtime/cases.ts
interface Case {
  case_id: string;
  process_id: string;
  process_version: string;
  subject: string;
  status: "running" | "done" | "error" | "cancelled";
  position: string;            // current element_id
  active_branches?: ActiveBranch[];  // set during AND/OR split
  payload: Record<string, unknown>;  // carries data between steps
  history: HistoryEntry[];
  created_at: string;
}

interface WorkItem {
  work_item_id: string;
  case_id: string | null;
  process_id: string | null;
  element_id: string | null;
  label: string;
  assignee: string;            // role name or agent id
  status: "pending" | "running" | "done" | "cancelled" | "error";
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  deadline?: string;
  created_at: string;
  updated_at: string;
}
```
