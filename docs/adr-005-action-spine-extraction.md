# ADR-005: Action Spine Framework Extraction

> Issue: #618 | Priority: P2 | Date: 2026-05-01 | Author: Kakashi
> Status: Planning phase — ADR defines package boundary, dependency inversion, and extraction slices.

Program dependency gate: #618 remains blocked by the BPMS milestone graph in
`docs/bpms-program-dependency-graph.md`. Do not start package extraction until
#684, #685, and #741-#744 are complete.

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
- `docs/action-spine-runbook.md` — operational runbook
- `docs/action-spine-cli.md` — CLI design notes
- `tests/action-spine-boundary.test.ts` — mechanical boundary enforcement
- `scripts/action-surface-report.ts` — surface report generator
