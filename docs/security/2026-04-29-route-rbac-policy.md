# Route RBAC Policy

Date: 2026-04-29

## Intent

Konoha API now separates three access levels:

- `admin`: dashboard session or `KONOHA_TOKEN`; can manage configuration, lifecycle, workflow definitions, cleanup, and operator control-plane routes.
- `agent-self-or-admin`: agent token can access only resources addressed to its own `agent_id`; admin can access all.
- `auth`: any valid admin or agent token; used for low-risk reads and bus primitives that already enforce resource ownership.

The direct CRUD API is intentionally stricter than `/act`. Direct workflow mutations are admin-only so agents cannot bypass the action envelope, autonomy matrix, and audit trail. Agents should use `/act` for workflow/case/workitem changes when delegated by the operator.

## Current Matrix

| Area | Read | Mutation |
| --- | --- | --- |
| `/agents` list/config/lifecycle/tmux | admin | admin |
| `/agents/:id` detail/status/template/memory/avatar | agent-self-or-admin | agent-self-or-admin for memory/avatar, admin for definition/lifecycle |
| `/workflows` direct CRUD | auth read | admin |
| `/cases` direct CRUD | auth read/stream | admin for start/close/delete |
| `/workitems` direct API | agent sees own assigned items, admin sees all | assignee can complete own item, admin manages create/update/cancel/cleanup |
| `/waits` | agent sees own waits, admin sees all | assignee can confirm own wait |
| `/reminders` | agent sees own reminders, admin sees all | admin |
| `/event-manager/subscribe` | auth read | admin |
| `/work-calendar/override` | auth read | admin |
| `/act` | auth | auth + autonomy/audit; high-risk downstream routes still enforce admin where applicable |

## Guardrails

- Runtime behavior is covered by `tests/server.test.ts` route RBAC tests.
- Static drift protection is covered by `scripts/check-route-auth-policy.py`.
- `scripts/healthcheck-system.py` runs the route policy checker and fails on route drift.
