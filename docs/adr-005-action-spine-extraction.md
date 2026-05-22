# ADR-005: Action Spine Framework Extraction

> Issue: #618 | Priority: P2 | Date: 2026-05-01 | Author: Kakashi
> Status: Initial private package scaffold implemented after accepted gates #684, #685, and #686.

Program dependency gate: #618 was held behind the BPMS milestone graph in
`docs/bpms-program-dependency-graph.md` until #684, #685, #686, and #741-#744
were accepted. Those gates are now closed as `state:done`, so #618 owns the
first private package scaffold. This does not authorize moving Konoha runtime
behavior or host vocabulary into the generic package.

Package extraction spike/readiness evidence after #741/#742 lives in
`docs/action-spine-package-extraction-spike.md`. Treat that document as the
current checklist for completed scaffold checks and remaining future extraction
checks.

Parent closure evidence for #684 lives in
`docs/action-spine-extraction-closure-report.md` and the matching
machine-readable report
`docs/action-spine-extraction-closure-report.json`. Closing #684 records that
the boundary/readiness evidence from #741-#744 is reconciled. #685 and #686 are
now accepted too, which permits the initial #618 scaffold recorded here while
keeping Konoha runtime behavior host-owned.

Issue #618 now owns the first reusable package scaffold in
`packages/action-spine`. The package exposes generic types, ports, a registry
factory, and injected MCP/CLI/HTTP adapters. Konoha action vocabulary, route
auth, MCP server wiring, workflow runtime, storage, and executor logic remain
host-owned.

## Current Extraction Readiness (2026-05-22)

Issue #618 has started with a private reusable package scaffold, not a runtime
move or public package release. The accepted #741/#742 slices define the in-repo
seams used by the scaffold:

| Area | Status | Evidence | Extraction impact |
|---|---|---|---|
| Generic core shapes | Ready | `src/action-spine/core-types.ts`, #742 | Reusable core types no longer encode Konoha action IDs or scopes. |
| Host ports | Ready | `src/action-spine/ports.ts`, #741 | Executor, audit, autonomy, HTTP route, and MCP bridge seams are explicit before package extraction. |
| Konoha host vocabulary split | Ready | `src/action-definitions.ts`, `src/action-registry.ts`, `src/action-policy.ts`, #742 | Concrete Konoha actions stay host-owned and are not part of generic core abstractions. |
| Boundary manifest | Ready | `src/action-spine/boundary.ts`, `tests/action-spine-boundary.test.ts` | Generic core, Konoha vocabulary, and Konoha adapters are mechanically distinguished. |
| Package scaffold | Ready | `packages/action-spine`, `tests/action-spine-package-core.test.ts`, `tests/action-spine-package-bridges.test.ts` | Reusable core/bridge API exists and uses injected ports. |
| Package-local injected bridges | Complete for scaffold | `packages/action-spine/src/bridges/*`, `tests/action-spine-package-bridges.test.ts` | MCP/CLI/HTTP helper APIs execute only through injected ports and sample host vocabulary. |
| Konoha MCP bridge adoption | Future check | `src/mcp-action-bridge.ts` remains adapter-side | Needs a later host wiring change before Konoha uses a package bridge. |
| Konoha HTTP route adoption | Future check | `src/act-envelope.ts` still owns Hono/auth/audit routing | Needs a later factory over ports plus route/auth regression evidence. |
| Konoha executor extraction | Blocked | `src/action-executor.ts` imports workflow/runtime/agent modules | Must remain a Konoha adapter behind `ActionExecutorPort`. |
| Golden-path acceptance | Complete | #685 and #686 accepted | Constructor -> deploy -> run -> assigned work item and release gate evidence are accepted; #812 remains open and not waived. |

### #618 Checklist

Completed prerequisite and scaffold checks:

- [x] #741 accepted: Action Spine port interfaces are defined in-repo first.
- [x] #742 accepted: generic core types are split from Konoha host vocabulary.
- [x] #743 accepted: this readiness checklist and blocker set is reviewed.
- [x] #744 accepted: bridge/package extraction readiness is reviewed.
- [x] #684 accepted: Action Spine extraction readiness umbrella is closed.
- [x] #685 accepted: golden-path acceptance suite proves assistant-created workflows can be deployed and executed.
- [x] #686 accepted: final release gate/runbook signs off production readiness.
- [x] #618 initial package scaffold: `packages/action-spine` exposes generic
  core/ports/registry/bridge APIs without importing Konoha runtime or host
  vocabulary.
- [x] No generic package/core file imports Konoha runtime, routes, storage,
  agent lifecycle, or concrete action vocabulary; this is covered by
  `tests/action-spine-boundary.test.ts` and package-local bridge/core tests.
- [x] `docs/action-surface.json` remains generated from the Konoha host
  vocabulary and does not become a hand-maintained package artifact.
- [x] #618 scaffold review checks include boundary, package bridge/core,
  workflow/action compatibility, action-surface, route-auth, typecheck, and diff
  checks.

Remaining future extraction checks:

- [ ] If Konoha adopts a package MCP bridge, `src/mcp-action-bridge.ts` must
  inject registry/executor/token dependencies instead of importing host
  internals from package code.
- [ ] If Konoha adopts a package HTTP route factory, `src/act-envelope.ts` must
  keep auth, audit, autonomy, endpoint fallback, and caller context injectable
  with focused route/security regressions.
- [ ] Public package publishing still needs a versioning/release decision and
  must not claim #812 closure or waiver.

### Remaining Guardrails

- #618 must not move `src/action-executor.ts` into reusable core; it is still a
  Konoha adapter with workflow/runtime/agent dependencies.
- #618 must not publish Konoha scopes such as `workflow`, `case`, `agent`,
  `retention`, or concrete IDs such as `workflow.deploy` as generic package
  vocabulary.
- #618 must not create a second mutation path outside `/act` and the accepted
  compatibility executors.
- #618 must not replace Konoha's MCP or HTTP host adapters with package-backed
  adapters until the host registry, executor, audit, autonomy, auth, and token
  dependencies are injectable and covered by focused route/bridge tests.
- #618 does not close, unpause, or waive #812; terminal-case release behavior
  remains governed by that open gate.

## 1. Context

Action Spine guarantees one canonical contract per business operation across HTTP, MCP, CLI, and UI surfaces. Today it lives inside Konoha as a set of source modules with a mechanically enforced boundary (`tests/action-spine-boundary.test.ts`). The goal is to extract the generic core into a reusable npm package so other projects can depend on it without pulling Konoha.

### Current module inventory

| Module | Lines | Layer |
|---|---|---|
| `action-policy.ts` | 64 | Generic core (zero Konoha imports) |
| `action-registry.ts` | 226 | Generic core (zero Konoha imports) |
| `action-definitions.ts` | 851 | Generic core (Konoha's action vocabulary; needs split) |
| `mcp-action-bridge.ts` | 101 | Generic core (zero Konoha imports) |
| `action-spine/boundary.ts` | 63 | Boundary manifest (forbidden-import list) |
| `action-executor.ts` | 791 | Konoha adapter (13+ Konoha runtime imports) |
| `act-envelope.ts` | 499 | Konoha adapter (Hono, auth middleware) |
| `action-handlers.ts` | 64 | Konoha adapter (workflow-loader, assistant-actions) |
| `executor-contract.ts` | 266 | Konoha auxiliary |
| `workflow-action-contract.ts` | 104 | Konoha auxiliary |

### Test coverage (all passing)

- `workflow-action-contract.test.ts` — registry validation, contracts, surface invariants
- `act-workflow-executor.test.ts` — `/act` endpoint + executor integration
- `mcp-action-bridge.test.ts` — MCP bridge (catalog, get, call, auth)
- `action-surface-report.test.ts` — surface report determinism
- `act-envelope.test.ts` — envelope + handler execution
- `action-spine-boundary.test.ts` — import boundary enforcement

## 2. Decision

Extract Action Spine into `@konoha/action-spine` as a scoped npm package with three sub-packages:

```
@konoha/action-spine
├── packages/
│   ├── core/          # action-spine-core: registry, policy, types, contracts
│   ├── bridge-mcp/    # action-spine-bridge-mcp: MCP tool adapter
│   └── bridge-http/   # action-spine-bridge-http: Hono adapter
```

### Package boundary

```
┌─────────────────────────────────────────────────┐
│ @konoha/action-spine-core                       │
│ ┌─────────────────────────────────────────────┐ │
│ │ Generic ActionDef/ActionSurfaceEntry shapes│ │
│ │ ActionCategory  ActionSecurityPolicy        │ │
│ │ Executor/Audit/Autonomy/HTTP/MCP ports      │ │
│ └─────────────────────────────────────────────┘ │
│ Action vocabulary lives in the host app,        │
│ not in core. Core defines the shape.            │
└─────────────────────────────────────────────────┘
         ▲                    ▲
         │ implements         │ implements
┌────────┴──────────┐  ┌──────┴──────────────────┐
│ bridge-mcp        │  │ Konoha (host app)        │
│ MCP tool adapter  │  │ action-executor.ts       │
│ actionCatalog()   │  │ act-envelope.ts          │
│ actionCall()      │  │ action-handlers.ts       │
│ actionGet()       │  │ action-definitions.ts    │
│                   │  │ action-registry.ts       │
│                   │  │ action-policy.ts         │
└───────────────────┘  └─────────────────────────┘
```

### Dependency inversion

Core defines ports (interfaces). Host apps and bridges implement them:

```ts
// @konoha/action-spine-core
export interface ActionExecutorPort {
  execute(actionId: string, args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult>;
}

export interface ActionAuditPort {
  log(entry: AuditEntry): Promise<void>;
}
```

Konoha's `action-executor.ts` implements `ActionExecutorPort`. The HTTP bridge wraps a Hono router around the port. The MCP bridge wraps MCP tool handlers around it.

Konoha-specific concerns (agent-lifecycle, workflow-loader, trigger-resolver, runtime/*, people-service, access-control, messenger-outbound, retention) stay inside Konoha and are injected through the port interface.

### What stays in Konoha

- All agent-specific logic (assistant-actions, agent-lifecycle)
- Workflow engine, trigger resolution, event manager
- Access control / RBAC
- People service, messenger outbound
- Retention / data lifecycle
- The concrete action vocabulary (`action-definitions.ts` — Konoha's actions, not generic)

### What moves to core

- `ActionDef`, `ActionCategory`, `ActionSecurityPolicy` types
- Registry: `registerAction`, `getAction`, `listActions`, `isValidAction`, `validateActionArgs`
- Policy: `classifyAction`, `getActionSecurity`
- Surface: `dumpRegistry`, `listActionSurface`, `getActionSurface`
- Contract validation and schema enforcement
- Port interfaces (`ActionExecutorPort`, `ActionAuditPort`)

## 3. Extraction slices

### Slice 1: Core package scaffold
- Create `@konoha/action-spine-core` package with `package.json`, `tsconfig.json`, build
- Move types: `ActionDef`, `ActionCategory`, `ActionSecurityPolicy`, `ActionSurfaceEntry`, etc.
- Move registry: `registerAction`, `getAction`, `listActions`, `isValidAction`, `validateActionArgs`, `dumpRegistry`
- Move policy: `classifyAction`, `getActionSecurity`
- Move boundary manifest: `action-spine/boundary.ts`
- Define port interfaces: `ActionExecutorPort`, `ActionAuditPort`
- Konoha imports from `@konoha/action-spine-core` instead of local paths
- **Gate:** all existing tests pass; `action-spine-boundary.test.ts` updated to check package imports

### Slice 2: MCP bridge package
- Create `@konoha/action-spine-bridge-mcp`
- Move `mcp-action-bridge.ts` logic, parameterize over registry
- Konoha's `mcp.ts` wires the bridge to Konoha's registry
- **Gate:** `mcp-action-bridge.test.ts` passes against the package

### Slice 3: HTTP bridge abstraction
- Create `@konoha/action-spine-bridge-http` with Hono adapter
- Define `createActRouter(registry, executor, options)` factory
- Konoha's `act-envelope.ts` delegates to the factory
- **Gate:** `act-envelope.test.ts` and `act-workflow-executor.test.ts` pass

### Slice 4: CLI bridge MVP
- Add `action-spine-cli` entry point to core package
- `npx action-spine <actionId> --args '{"key":"val"}'` calls the configured executor
- Supports `--dry-run`, `--output json|text`
- **Gate:** `action-spine-cli.test.ts` passes

### Slice 5: Codegen
- Add `action-spine-codegen` script
- Generates TypeScript types from registry
- Generates OpenAPI spec from action definitions
- Generates action surface JSON (already exists as `action-surface-report.ts`)
- **Gate:** generated output matches current `action-surface.json` snapshot

### Slice 6: Docs and release checklist
- Quickstart guide
- Action contract lifecycle doc
- Migration guide from Konoha-internal to package
- Release checklist (versioning, changelog, npm publish)

## 4. Non-regression contract

Every slice keeps Konoha green:
- `bun test` — all existing tests pass
- `bun run typecheck` — no new errors
- `bun run build` — frontend builds
- `action-spine-boundary.test.ts` — import boundary enforced (updated per slice)
- `action-surface-report.ts --check` — no drift

## 5. MVP estimate

| Slice | Effort | Risk |
|---|---|---|
| 1. Core scaffold | 2-3h | Low — mechanical extraction |
| 2. MCP bridge | 1-2h | Low — thin wrapper |
| 3. HTTP bridge | 2-3h | Medium — Hono integration surface |
| 4. CLI bridge | 1-2h | Low — standalone entry point |
| 5. Codegen | 2-3h | Medium — schema generation accuracy |
| 6. Docs | 1-2h | Low — documentation |

**Total MVP: 9-15h.** Each slice is independently shippable and keeps Konoha green.

## 6. Open questions

- npm publish scope: `@konoha` org on npmjs.com or private registry?
- Versioning strategy: independent per package or lockstep?
- Monorepo tooling: turborepo, nx, or bun workspaces?

## 7. References

- `docs/action-spine-boundary.md` — current boundary manifest docs
- `docs/action-spine-package-extraction-spike.md` — post-#741/#742 extraction
  spike, injectable dependency map, and blocker checklist
- `docs/action-spine-runbook.md` — operational runbook
- `docs/action-spine-cli.md` — CLI design notes
- `tests/action-spine-boundary.test.ts` — mechanical boundary enforcement
- `scripts/action-surface-report.ts` — surface report generator
