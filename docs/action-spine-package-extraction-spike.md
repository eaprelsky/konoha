# Action Spine Package Extraction Spike

Date: 2026-05-22

Issue #744 records extraction readiness evidence for #618. This is a spike, not
an implementation plan to move files today. Package extraction remains gated by
#684, #685, and #686 after the #741-#744 boundary/readiness slices are accepted.
Issue #684 reconciles this spike with the accepted boundary/checklist slices in
`docs/action-spine-extraction-closure-report.md` and
`docs/action-spine-extraction-closure-report.json`; that report is parent
evidence only and does not authorize #618 extraction before #685/#686.
Issue #618 now adds the first package scaffold in `packages/action-spine`;
runtime adapters still remain host-owned.

## Current State

| Layer | Current files | Status |
| --- | --- | --- |
| Generic core shapes | `src/action-spine/core-types.ts` | Ready to become package-owned after gates. No Konoha action IDs/scopes. |
| Generic host ports | `src/action-spine/ports.ts` | Ready to become package-owned after gates. Defines executor, audit, autonomy, HTTP, and MCP seams. |
| Extracted package scaffold | `packages/action-spine/src` | Initial #618 package surface. Owns generic types, ports, registry factory, and injected bridge adapters. |
| Konoha host vocabulary | `src/action-definitions.ts`, `src/action-registry.ts`, `src/action-policy.ts` | Stays in Konoha. Owns `KonohaActionScope`, concrete action IDs, defaults, and generated surface. |
| Konoha executor adapter | `src/action-executor.ts` | Stays in Konoha. Imports workflow/runtime/agent modules and implements `ActionExecutorPort`. |
| HTTP adapter | `src/act-envelope.ts` | Not ready to extract. Still owns Hono, auth, audit/autonomy, direct executor routing, and endpoint fallback. |
| MCP adapter | `src/mcp-action-bridge.ts` | Not ready to extract. Bridge is thin, but currently imports Konoha registry directly. |
| Boundary guard | `src/action-spine/boundary.ts`, `tests/action-spine-boundary.test.ts` | Ready. Enforces generic core vs Konoha vocabulary vs adapters. |

## Allowed Spike Outcome

The next extraction attempt may create a package scaffold only after all gates
below are closed. Until then, accepted work may only improve:

- type-only generic contracts;
- import-boundary tests;
- docs/checklists;
- dependency injection seams for adapters;
- non-runtime package shape notes.

Do not move runtime behavior, publish packages, or introduce new import aliases
as part of #744.

## Proposed Package Shape

```text
packages/action-spine-core/
  src/core-types.ts          # from src/action-spine/core-types.ts
  src/ports.ts               # from src/action-spine/ports.ts
  src/registry-core.ts       # future generic registry factory over host vocabulary
  src/surface.ts             # future generic surface helpers

packages/action-spine-bridge-mcp/
  src/index.ts               # future registry-injected MCP catalog/get/call helpers

packages/action-spine-bridge-http/
  src/index.ts               # future createActRouter(...) factory
```

Konoha remains the host app:

```text
src/action-definitions.ts    # concrete Konoha vocabulary
src/action-registry.ts       # Konoha registry over core shapes
src/action-policy.ts         # Konoha policy defaults
src/action-executor.ts       # Konoha ActionExecutorPort implementation
src/act-envelope.ts          # Konoha HTTP adapter until route factory is accepted
src/mcp-action-bridge.ts     # Konoha MCP adapter until registry injection is accepted
```

The implemented #618 scaffold uses a single private workspace package at
`packages/action-spine` first. It can later split into `core`, `bridge-mcp`, and
`bridge-http` packages without changing the host vocabulary boundary.

## Required Injectable Dependencies

Before any bridge moves into a package, the package-facing API must inject these
host dependencies instead of importing Konoha modules:

| Dependency | Current owner | Required package-facing seam |
| --- | --- | --- |
| Action registry | `src/action-registry.ts` | Registry/catalog provider over generic `ActionDef<TScope>`. |
| Direct execution | `src/action-executor.ts` | `ActionExecutorPort`. |
| Audit writes | `src/assistant-actions.ts` | `ActionAuditPort`. |
| Autonomy policy | `src/assistant-actions.ts` | `ActionAutonomyPolicyPort`. |
| HTTP auth/caller context | `src/middleware/auth.ts`, `src/types.ts` | Host-provided caller resolver and auth policy. |
| HTTP framework | `src/act-envelope.ts` | `createActRouter` factory or host callback adapter. |
| MCP API/token access | `src/mcp.ts`, `src/mcp-action-bridge.ts` | Injected API caller and token provider. |
| Endpoint fallback | `src/act-envelope.ts` | Host-only compatibility adapter; not generic core. |

## Readiness Checklist

- [x] #741 accepted: ports exist before extraction.
- [x] #742 accepted: generic core types are split from Konoha host vocabulary.
- [x] #743 accepted: #618 checklist/blockers are documented.
- [x] #744 accepted: this spike is reviewed and linked to #618/#684.
- [ ] #684 accepted: extraction readiness umbrella is closed.
- [ ] #685 accepted: constructor -> deploy -> run -> assigned work item golden path passes.
- [ ] #686 accepted: final release gate/runbook signs off production readiness.
- [ ] MCP bridge has a registry-injected test that does not import Konoha vocabulary from package code.
- [ ] HTTP bridge has a port-injected route factory test covering auth, autonomy, audit, endpoint fallback, and direct executor paths.
- [ ] Package scaffold has no Konoha runtime, route, storage, workflow, agent, or concrete action vocabulary imports.
- [ ] Konoha still passes `action-surface-report.ts --check`; `docs/action-surface.json` remains host-generated.
- [x] #618 initial package scaffold exists with package-local tests for core,
  MCP, CLI, and HTTP bridge injection.

## Blockers For #618

- Do not extract `src/action-executor.ts`; it is a Konoha adapter with product
  runtime dependencies.
- Do not extract `src/action-definitions.ts` as generic package vocabulary;
  it is Konoha host vocabulary.
- Do not move `src/action-policy.ts` defaults into generic core unless policy is
  parameterized by host scope and all Konoha scopes remain host-owned.
- Do not extract `src/act-envelope.ts` until auth, audit, autonomy, executor,
  endpoint fallback, and caller context are injectable and tested.
- Do not extract `src/mcp-action-bridge.ts` until it accepts a registry provider
  and no package code imports Konoha registry/vocabulary.
- Do not start #618 extraction while #685/#686 acceptance evidence is missing.

## Minimum Checks For A Future Extraction Commit

```bash
bun test --timeout 30000 tests/action-spine-boundary.test.ts tests/workflow-action-contract.test.ts
bun test --timeout 30000 tests/mcp-action-bridge.test.ts tests/act-envelope.test.ts tests/act-workflow-executor.test.ts
bun run typecheck
bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
git diff --check
```

The future package commit must also include package-local tests proving the
package imports only generic core files or injected host ports.
