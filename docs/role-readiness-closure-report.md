# Role Readiness Parent Closure Report

Issue #679 is the parent umbrella for executable role readiness and real work
item delivery. The machine-readable closure receipt is
`docs/role-readiness-closure-report.json`.

## Closure Invariant

A workflow may be executable only when every function role resolves to a system
role, explicit manual queue, online-capable agent, capability match, or
Telegram-reachable person. Runtime dispatch may claim delivery only with target
evidence in the `workitem.dispatch` receipt.

## Covered Surfaces

| Surface | Contract |
| --- | --- |
| Readiness validation | `workflow.validate`, deploy, patch, and case-start receipts emit `ROLE_UNRESOLVABLE`, `ROLE_MISSING_ASSIGNEE`, and `ROLE_ASSIGNEE_UNRESOLVABLE` blockers. |
| Deploy gate | `workflow.deploy` refuses unresolved roles; workflow-created skeleton roles do not count as manual queues. |
| Dispatch evidence | `workitem.dispatch` receipts include `target_type`, `target_id`, `target_ids`, `strategy`, `dispatch_status`, and `targets[]`. |
| Operator remediation | ProcessEditor diagnostics converts role readiness errors into `role.create` or `role.update` Action Spine payloads. |
| Assistant remediation | Tsunade role assignment suggestions are accepted only when grounded in the current `workflow.validate` role error and require operator confirmation. |

## Child Evidence

Closed detailed slices: #721, #722, #723, and #724.

Together these cover the original #679 acceptance criteria for validation,
deploy blocking, target receipts, UI remediation, assistant suggestions, and
tests for agent, capability, person, manual, and unresolved roles.

## Direct Paths Kept

- Manual queue: an operator-created `strategy: "manual"` RoleDef with no
  assignees is an explicit target.
- System role: built-in system-agent execution is valid and still produces
  system target receipt details.

## Review Commands

```bash
PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 \
  tests/role-readiness-closure-report.test.ts \
  tests/workflow-role-readiness.test.ts \
  tests/zz_dispatcher.test.ts \
  tests/workitem-dispatch-outbox.test.ts \
  tests/backend-golden-path.test.ts

PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 \
  tests/assistant-response.test.ts \
  tests/workflow-validation-taxonomy.test.ts \
  tests/workflow-lifecycle-gate.test.ts

cd frontend && PATH=/home/ubuntu/.bun/bin:$PATH bun run test -- roleAssignmentResolution workflowDiagnosticsPanel

PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
PATH=/home/ubuntu/.bun/bin:$PATH bun run typecheck
```

## Closure Recommendation

#679 can close after Shikadai review as the role readiness and dispatch target
evidence umbrella. This does not bypass the #686 release process or the #812
terminal-case gate.
