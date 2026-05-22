# ADR-006: Konoha Packaging and Deployment Boundaries

> Issue: #797 | Priority: P1 | Date: 2026-05-20 | Author: Kakashi
> Status: Proposed for review

## Context

Konoha currently ships from one repository and one primary production service.
That service is a useful bootstrap monolith, but it now contains several
different architectural responsibilities:

- bus/control plane: `core/src/server.ts`, `src/redis.ts`,
  `src/routes/messages.ts`, `src/routes/agents.ts`, `src/mcp.ts`
- Workflow Engine/runtime: `modules/workflow-engine/`, `src/runtime/`,
  `src/dispatcher.ts`, `src/action-executor.ts`, `src/event-manager.ts`
- web UI: `frontend/src`, built `dist/ui`, static `/ui` serving
- agent/runtime infrastructure: `agents/`, `scripts/watchdog-*`, `systemd/`
- connectors/adapters: `src/adapters/`, `src/clients/`,
  `src/messenger-*`, Telegram bus services
- legacy operational dashboard: separate `/home/ubuntu/konoha-dashboard`
  repo/service on port `3201`

The current composition root is `core/src/server.ts`. It imports platform
routes, initializes schedulers/listeners, mounts static UI, mounts the Workflow
Engine module with `app.route("/", workflowEngineModule)`, and starts the
Workflow Engine `event_fired` listener in the same Bun process.

`modules/workflow-engine/src` is not independently deployable today. Its routes
import Konoha auth, Redis, runtime, workflow-loader, event-log, and
Action Spine executor modules directly. `modules/workflow-engine/frontend` is
mostly a plugin wrapper over canonical UI files in `frontend/src` through the
`@core` alias.

`docs/adr-005-action-spine-extraction.md` already defines a package extraction
path for the generic Action Spine core, but it intentionally keeps
Konoha-specific execution logic inside this repo.

## Decision

Choose **Option B: monorepo, multiple deployable services over time**.

Konoha stays in one repository for the next architecture phase. The target is
not a multi-repo split. The target is a monorepo with explicit module/package
boundaries and a gradual move from one primary Bun service to several
deployable services where isolation improves reliability.

Until those slices are accepted and implemented, production remains a modular
monolith: `konoha.service` continues to run `core/src/server.ts` as the
composition root. No behavior-heavy package move should happen before this ADR
is accepted and follow-up issues are created.

## Target Logical Boundaries

| Boundary | Current physical layout | Target package/service role |
|----------|--------------------------|-----------------------------|
| `@konoha/bus` | `src/redis.ts`, `src/routes/messages.ts`, `src/routes/agents.ts`, `src/mcp.ts`, bus-related storage | Control-plane API, Konoha bus, presence, message routing, MCP action surface |
| `@konoha/workflow-engine` | `modules/workflow-engine/src`, `src/runtime`, `src/workflow-loader.ts`, `src/dispatcher.ts`, workflow/case/work-item routes | Product module with stable API; later deployable as engine API/worker when storage and event ports are ready |
| `@konoha/web` | `frontend/src`, `modules/workflow-engine/frontend`, `dist/ui`, static middleware | Canonical operator/product UI; build artifact served by Konoha now, separable static artifact later |
| `@konoha/action-spine` | `src/action-*`, `src/mcp-action-bridge.ts`, `src/act-envelope.ts` | Shared action contract package per ADR-005, with Konoha executor as host adapter |
| `@konoha/agent-runtime` | `src/agent/*`, `src/agent-lifecycle.ts`, `scripts/watchdog-*`, `agents/`, `systemd/agent-*` | Managed agent definitions, tmux/runtime launch, watchdog delivery, agent resource policy |
| `@konoha/connectors` | `src/adapters`, `src/clients`, `src/messenger-*`, Telegram services | Connector adapters that ingest external events and emit normalized workflow/action events |
| `@konoha/testbench` | `konoha-testbench/` | Already a separate bounded service for GUI verification |

Package names are target boundary names, not an instruction to move files in
this ADR commit.

## Deployment Target

### Phase 0: current production shape

Keep one primary service:

```text
konoha.service
  -> core/src/server.ts
  -> bus/control-plane routes
  -> Workflow Engine routes and in-process listeners
  -> static UI
  -> /act and MCP-facing action surface
```

Agent services, watchdog services, Telegram bus services, and TestBench remain
separate supporting services.

### Phase 1: monorepo packages, same primary service

Introduce package-level boundaries in the repo without changing deployment:

```text
core/src/server.ts
  imports boundary entrypoints only:
    @konoha/bus/http
    @konoha/workflow-engine/http
    @konoha/web/static
    @konoha/agent-runtime/http
    @konoha/connectors/http
```

The composition root may wire modules together. Product modules must not reach
across boundaries except through allowed ports.

### Phase 2: split deployable services where useful

Split only after package boundaries and tests make the cut safe:

```text
bus/control-plane service
  owns: messages, agents, presence, MCP, /act host routing

workflow-engine worker/API service
  owns: cases, work items, waits, workflow execution loops
  communicates through Action Spine/events and storage ports

web static service/artifact
  owns: frontend build, no business writes except API calls

connector workers
  own: Telegram, CRM, GitHub, tracker, mail ingestion/outbound adapters

agent-runtime supervisor
  owns: managed agent start/stop/restart, watchdog delivery, runtime resource policy
```

Do not split a service merely to make the repository look cleaner. Split when a
runtime has independent scaling, failure isolation, credential scope, or
resource-budget needs.

## Allowed Dependencies

The intended dependency direction is inward to stable contracts, not sideways
to implementation details.

```text
web
  -> HTTP/API clients
  -> Action Spine action ids

MCP / external clients
  -> Action Spine bridge
  -> bus/control-plane API

connectors
  -> connector client facades
  -> Action Spine/events
  -> bus outbound message port

workflow-engine
  -> Action Spine contracts
  -> workflow storage port
  -> event bus port
  -> dispatcher/assignment port
  -> adapter execution port for system-bound functions

agent-runtime
  -> bus/control-plane API
  -> runtime config/storage port
  -> MCP config builder

bus/control-plane
  -> storage facades
  -> Action Spine host adapter
  -> agent-runtime port for lifecycle operations

core composition root
  -> all boundary entrypoints
```

## Forbidden Dependencies

- `frontend/src` must not import server runtime modules directly.
- `modules/workflow-engine/frontend` must not fork canonical workflow UI logic;
  it can re-export `frontend/src` or host genuinely module-specific pages.
- Workflow Engine domain/runtime code must not call Hono route modules.
- Workflow Engine domain/runtime code must not depend on agent prompt files,
  tmux process code, watchdog scripts, or systemd files.
- Connectors must not own hidden business process logic in long-lived prompts;
  they emit events/actions and handle transport-specific IO.
- Agent runtime must not reach into Workflow Engine storage internals to mutate
  cases/work items; it should complete work through Action Spine/API contracts.
- MCP tools must not create a second mutation path that bypasses Action Spine
  for new write behavior.
- Bus/control-plane code must not import frontend code or TestBench internals.
- No package may read raw production credentials from another package's config
  files; credentials flow through environment/secret references and connector
  facades.

## Workflow Engine Boundary

Workflow Engine is a **product module with a stable API**, not part of the
generic Konoha bus core.

It remains colocated in this repo because it is the main product module and
still shares active storage and action contracts with Konoha. It should be made
independently deployable only after:

- workflow routes depend on storage/event/action ports rather than direct Redis
  and PostgreSQL modules;
- the execution loop can run outside `core/src/server.ts`;
- Action Spine extraction has a stable host adapter per ADR-005;
- BPMS reliability gates from #672 can validate the split under load.

## Redis/PostgreSQL and Action Spine

For Phase 0 and Phase 1, bus and Workflow Engine may share Redis/PostgreSQL
facades because production is still one process and the `PG_READ` cutover is
not complete.

The target dependency is not "share database tables freely". The target is:

- bus/control-plane owns message, presence, agent definition, and channel
  storage ports;
- Workflow Engine owns workflow, case, work item, wait, role, document, and
  reminder storage ports;
- cross-boundary writes go through Action Spine actions or normalized events;
- direct Redis/PostgreSQL access across module boundaries is treated as
  transitional debt and should be removed slice by slice.

This is compatible with ADR-005: generic Action Spine moves toward a package,
while Konoha-specific execution remains a host adapter that calls product
ports.

Before extracting the Action Spine package, Konoha defines generic core action
shapes in `src/action-spine/core-types.ts` and host interfaces in
`src/action-spine/ports.ts`. Concrete Konoha action IDs/scopes remain host
vocabulary in `src/action-definitions.ts`, `src/action-registry.ts`, and
`src/action-policy.ts`; `src/action-executor.ts` and other workflow/runtime
imports stay on the Konoha adapter side.

## Old `konoha-dashboard`

`konoha-dashboard` is **legacy ops-only** and should not receive new product UI
work.

Current status:

- it is a separate repo/service on port `3201`;
- docs reserve port `3201` for it to avoid E2E/TestBench conflicts;
- the canonical product/workflow UI now lives in `frontend/src` and is served
  from this repo;
- TestBench is the supported GUI verification service on port `3203`.

Decision:

- keep `konoha-dashboard` temporarily as an ops-only compatibility dashboard;
- do not add product features there;
- merge any still-useful operational views into `frontend/src` or Konoha
  control-plane routes before retirement;
- after replacement, retire `konoha-dashboard.service` and free port `3201` in
  a dedicated issue.

## Migration Plan

1. Accept this ADR and create follow-up issues for mechanical boundary moves.
2. Add a machine-readable boundary manifest and tests for the allowed/forbidden
   import directions.
3. Move only pure or low-coupling code first: Action Spine core per ADR-005,
   typed storage/event ports, module entrypoints.
4. Keep `core/src/server.ts` as the only composition root while imports are
   being inverted.
5. Make Workflow Engine routes depend on ports, then isolate the execution
   listener behind a worker entrypoint.
6. Move connector loops into connector-worker entrypoints after event/action
   contracts are stable.
7. Decide service split order from resource and reliability data, not from file
   layout alone.
8. Retire `konoha-dashboard` only after replacement views and port docs are
   updated.

Candidate follow-up issues after ADR acceptance:

- add `docs/konoha-boundary-manifest.json` and boundary tests;
- introduce `@konoha/workflow-engine` route/runtime entrypoint without moving
  behavior;
- introduce storage/event/dispatcher ports for Workflow Engine;
- extract connector worker entrypoints for Telegram/CRM/GitHub ingestion;
- merge or retire remaining `konoha-dashboard` ops views;
- align ADR-005 package slices with the monorepo service plan.

## Non-Goals

- No multi-repo extraction in this phase.
- No large file moves before the ADR is accepted.
- No production service split before import boundaries and reliability tests
  exist.
- No retirement of `konoha-dashboard` in this ADR commit.

## Consequences

Positive:

- keeps production stable while clarifying long-term boundaries;
- gives Workflow Engine a product-module boundary without premature repo split;
- keeps Action Spine extraction compatible with BPMS reliability work;
- creates a path for connector and agent-runtime isolation when resource data
  justifies it.

Costs:

- some transitional direct imports remain in place;
- package names will exist as policy before they exist as physical packages;
- follow-up work must enforce the boundary mechanically, or the ADR will drift.

## Review Checklist

- [ ] Shikadai accepts the selected Option B target.
- [ ] Follow-up issues are created only after ADR acceptance.
- [ ] First follow-up is boundary manifest/tests, not a large refactor.
- [ ] Any service split proposal includes rollback and production preflight
      requirements.
