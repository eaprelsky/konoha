# Action Spine Extraction Closure Report

Date: 2026-05-22

Issue #684 reconciles the accepted extraction-readiness slices #741, #742,
#743, and #744. This is parent closure evidence only. It does not move runtime
code into a package and does not unblock #618 extraction by itself.

## Closure Decision

Action Spine is prepared for future package extraction at the boundary level:

- `src/action-spine/core-types.ts` and `src/action-spine/ports.ts` define the
  generic reusable core and host ports.
- `src/action-definitions.ts`, `src/action-registry.ts`, and
  `src/action-policy.ts` remain Konoha host vocabulary.
- `src/action-executor.ts`, `src/act-envelope.ts`, and
  `src/mcp-action-bridge.ts` remain Konoha adapters because they still bind to
  workflow, runtime, auth, audit, autonomy, agent, route, and token behavior.
- `docs/action-spine-package-extraction-spike.md` documents the future package
  shape and the injectable dependencies required before any bridge moves.

Package extraction is still blocked until #685, #686, and the #618
package-specific readiness work are accepted. Closing #684 means the extraction
gate is explicit and reviewable, not that extraction has started.

## Accepted Child Evidence

| Issue | Accepted evidence | Parent outcome |
| --- | --- | --- |
| #741 | `src/action-spine/ports.ts`, `src/action-spine/boundary.ts`, `tests/action-spine-boundary.test.ts` | Core ports exist before extraction. |
| #742 | `src/action-spine/core-types.ts`, `src/action-definitions.ts`, `src/action-registry.ts`, `src/action-policy.ts` | Generic core shapes are split from Konoha vocabulary. |
| #743 | `docs/adr-005-action-spine-extraction.md` | #618 checklist and blockers are documented. |
| #744 | `docs/action-spine-package-extraction-spike.md` | Future package shape is recorded as a spike, not implemented. |

## Non-Negotiable Gates

- Generic core must not import Konoha action definitions, registry, policy,
  workflow runtime, routes, storage, agent lifecycle, or MCP/HTTP adapters.
- Konoha action IDs such as `workflow.deploy`, `case.start`, and `role.create`
  remain host vocabulary.
- Runtime adapters stay in Konoha until their registry, executor, audit,
  autonomy, auth, caller context, token, and endpoint fallback dependencies are
  injected and covered by package-local tests.
- #618 extraction remains blocked by #685 golden-path acceptance and #686
  release gate evidence.

## Review Evidence

Machine-readable evidence lives in
`docs/action-spine-extraction-closure-report.json`. The focused regression is
`tests/action-spine-extraction-closure-report.test.ts`.

Reviewer command set:

```bash
python3 -m json.tool docs/action-spine-extraction-closure-report.json >/dev/null
PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 tests/action-spine-extraction-closure-report.test.ts tests/action-spine-boundary.test.ts tests/action-spine-cli.test.ts tests/zzz_system-agent-action-spine.test.ts
PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
PATH=/home/ubuntu/.bun/bin:$PATH bun run typecheck
git diff --check
```
