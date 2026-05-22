# Action Spine Package

Issue #618 introduces the first reusable Action Spine TypeScript package
surface in `packages/action-spine`. This package is intentionally generic. It
does not contain Konoha action IDs, Konoha scopes, workflow runtime handlers,
route auth, storage, MCP server wiring, or agent lifecycle behavior.

## Package Scope

The package owns:

- generic action definition and surface types;
- executor, audit, autonomy, registry, HTTP, MCP, and CLI port interfaces;
- an in-memory registry factory over host-provided action definitions;
- injected MCP, CLI, and HTTP adapters that call host ports.

The package does not own:

- `src/action-definitions.ts`;
- `src/action-registry.ts`;
- `src/action-policy.ts`;
- `src/action-executor.ts`;
- `src/act-envelope.ts`;
- `src/mcp-action-bridge.ts`;
- Workflow Engine runtime, Redis/PostgreSQL storage, routes, or agent lifecycle.

## Host Vocabulary

Konoha remains the host application. Concrete action IDs such as
`workflow.deploy`, `case.start`, and `role.create` stay in the host registry.
The package only knows that an action has an ID, arguments, implementation
metadata, security policy, autonomy default, and audit flag.

## Injected Bridges

`packages/action-spine/src/bridges/mcp.ts` exposes catalog/get/call helpers over
an injected registry and call port.

`packages/action-spine/src/bridges/cli.ts` parses CLI arguments, validates them
against an injected registry, dry-runs mutations, and executes reads/writes only
through an injected executor.

`packages/action-spine/src/bridges/http.ts` validates envelopes, calls optional
autonomy/audit ports, and executes through an injected executor. It is framework
neutral; Konoha's Hono route remains in `src/act-envelope.ts`.

## Boundary Tests

Run:

```bash
PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 \
  tests/action-spine-package-core.test.ts \
  tests/action-spine-package-bridges.test.ts \
  tests/action-spine-boundary.test.ts
```

The tests prove that:

- package registry behavior works with non-Konoha sample scopes;
- MCP/CLI/HTTP bridges use injected ports;
- package source does not import Konoha vocabulary, runtime, routes, storage,
  agent lifecycle, or MCP server code;
- Konoha execution remains adapter-side.

## Extraction State

This is an initial reusable package scaffold and compatibility surface. It does
not move Konoha runtime behavior out of the host application and does not waive
the #812 terminal-case rule. Further bridge adoption can be incremental after
focused Konoha compatibility tests stay green.
