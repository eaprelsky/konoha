# Action Spine package boundary

Issue #618 tracks extracting Action Spine into a reusable TypeScript framework. This slice defines the first boundary without moving behavior-heavy Konoha adapters.

## Core

Core files are registry/policy/bridge code that can be imported without Konoha workflow runtime state:

| File | Role | Coupling rule |
| --- | --- | --- |
| `src/action-definitions.ts` | Declarative action vocabulary | No workflow/runtime/agent imports |
| `src/action-registry.ts` | Registry API, contracts, validation, surface dump | No workflow/runtime/agent imports |
| `src/action-policy.ts` | Category and default security classification | No workflow/runtime/agent imports |
| `src/mcp-action-bridge.ts` | MCP catalog/get/call helpers over injected HTTP API | May depend on `zod` and registry only |

`src/action-spine/boundary.ts` is the machine-readable manifest for this boundary.

## Konoha Adapters

Adapters bind the generic action surface to this deployment:

| File | Adapter responsibility |
| --- | --- |
| `src/act-envelope.ts` | Hono `/act` route, auth, audit/autonomy calls, endpoint fallback |
| `src/action-executor.ts` | Direct execution against workflow, case, work item, role, agent, reminder, access, and KB services |
| `src/action-handlers.ts` | Registered Konoha handlers such as GitHub issue creation |
| `src/routes/agents.ts`, `src/routes/roles.ts` | Legacy REST routes using the direct executor |

## Ports

The reusable package should depend on ports, not Konoha modules:

- `ActionExecutorPort`: execute a validated action ID with typed args.
- `ActionAuditPort`: record audited attempts and outcomes.
- `ActionAutonomyPolicyPort`: resolve `auto`, `confirm`, or `disabled`.
- `HttpActionRouteAdapter`: expose `/act` in a host HTTP framework.
- `McpActionBridgeAdapter`: call `/act` through an injected API/token provider.

## First extraction rule

Do not move `src/action-executor.ts` into core yet. It imports Konoha workflow/runtime/agent modules directly and should become a Konoha adapter behind `ActionExecutorPort`.

Before adding core imports, run:

```bash
bun test tests/action-spine-boundary.test.ts
```
