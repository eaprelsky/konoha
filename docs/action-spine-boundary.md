# Action Spine package boundary

Issue #618 tracks extracting Action Spine into a reusable TypeScript framework. This slice defines the first boundary without moving behavior-heavy Konoha adapters.

## Generic Core

Generic core files define reusable shapes and host ports. They must not contain
concrete Konoha action IDs, scopes, policy defaults, routes, or runtime imports:

| File | Role | Coupling rule |
| --- | --- | --- |
| `src/action-spine/core-types.ts` | Generic action definition/result/security shapes | No Konoha action IDs, scopes, or runtime imports |
| `src/action-spine/ports.ts` | Type-only core port interfaces for host adapters | No workflow/runtime/agent imports |
| `packages/action-spine/src/core-types.ts` | Package-owned generic action shapes | No Konoha action IDs, scopes, or runtime imports |
| `packages/action-spine/src/ports.ts` | Package-owned generic port interfaces | No workflow/runtime/agent imports |
| `packages/action-spine/src/registry.ts` | Package-owned registry factory over host vocabulary | Host injects action definitions, classification, and security |
| `packages/action-spine/src/index.ts` | Public package exports | Re-export generic package surface only |

## Package Bridges

The reusable package also contains injected bridge adapters:

| File | Role | Coupling rule |
| --- | --- | --- |
| `packages/action-spine/src/bridges/mcp.ts` | Registry-backed MCP catalog/get/call helper | Calls only an injected action port |
| `packages/action-spine/src/bridges/cli.ts` | CLI parser/dry-run/executor bridge | Executes only through an injected executor |
| `packages/action-spine/src/bridges/http.ts` | Framework-neutral HTTP envelope adapter | Uses injected registry, executor, audit, and autonomy ports |

These bridges are package-local compatibility scaffolds. Konoha's production
Hono route, MCP server integration, and direct executor remain host adapters
until separate compatibility migrations are reviewed.

## Konoha Host Vocabulary

Konoha owns the concrete action vocabulary and policy defaults. These files are
kept in-repo for now, but they are host vocabulary rather than generic Action
Spine core:

| File | Role | Coupling rule |
| --- | --- | --- |
| `src/action-definitions.ts` | Declarative action vocabulary | No workflow/runtime/agent imports |
| `src/action-registry.ts` | Konoha registry API, contracts, validation, surface dump | Uses generic core types with `KonohaActionScope` |
| `src/action-policy.ts` | Konoha category and default security classification | May contain Konoha scope defaults |

`src/action-spine/boundary.ts` is the machine-readable manifest for this boundary.
The ports are intentionally defined inside Konoha first; this is an interface
seam for future extraction, not a package move.

## Konoha Adapters

Adapters bind the generic action surface to this deployment:

| File | Adapter responsibility |
| --- | --- |
| `src/act-envelope.ts` | Hono `/act` route, auth, audit/autonomy calls, endpoint fallback |
| `src/action-executor.ts` | Direct execution against workflow, case, work item, role, agent, reminder, access, and KB services |
| `src/action-handlers.ts` | Registered Konoha handlers such as GitHub issue creation |
| `src/mcp-action-bridge.ts` | MCP catalog/get/call helpers over injected HTTP API and Konoha registry |
| `src/routes/agents.ts`, `src/routes/roles.ts` | Legacy REST routes using the direct executor |

## Ports

The reusable package should depend on ports, not Konoha modules. The current
canonical definitions live in `src/action-spine/ports.ts` and are mirrored in
`packages/action-spine/src/ports.ts` for the extracted package surface:

- `ActionExecutorPort`: execute a validated action ID with typed args and return
  `{status, data}` or `null` when the host has no direct executor.
- `ActionAuditPort`: record audited attempts and outcomes without exposing
  Konoha audit storage to core code.
- `ActionAutonomyPolicyPort`: resolve `auto`, `confirm`, or `disabled` using
  host policy state.
- `HttpActionRouteAdapter`: expose action envelope execution in a host HTTP
  framework.
- `McpActionBridgeAdapter`: expose catalog/get/call helpers through an injected
  API/token provider.

Konoha currently implements the executor seam with
`konohaActionExecutorPort` in `src/action-executor.ts`. Audit/autonomy remain
implemented by `src/assistant-actions.ts`; `/act` remains implemented by
`src/act-envelope.ts`; MCP remains implemented by `src/mcp-action-bridge.ts`.

## First extraction rule

Do not move `src/action-executor.ts` into core yet. It imports Konoha workflow/runtime/agent modules directly and should become a Konoha adapter behind `ActionExecutorPort`.

Before adding core imports, run:

```bash
bun test --timeout 30000 tests/action-spine-package-core.test.ts tests/action-spine-package-bridges.test.ts tests/action-spine-boundary.test.ts
```
