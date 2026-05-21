# API Contract

Date: 2026-05-18

Every API endpoint → action ID → autonomy level → audit status. Generated from the canonical action registry. The `/act` endpoint is the universal entry point for all actions.

## Workflow Actions

| Endpoint | Action | Autonomy | Audited |
|----------|--------|----------|---------|
| `POST /workflows` | `workflow.create` | confirm | yes |
| `GET /workflows` | `workflow.list` | auto | no |
| `GET /workflows/:id` | `workflow.get` | auto | no |
| `PUT /workflows/:id` | `workflow.update` | confirm | yes |
| `/act` direct | `workflow.deploy` | confirm | yes |
| `/act` direct | `workflow.retire` | confirm | yes |
| `DELETE /workflows/:id` | `workflow.delete` compatibility route for retire | confirm | yes |

## Element Actions

| Endpoint | Action | Autonomy | Audited |
|----------|--------|----------|---------|
| `/act` direct | `element.add` | confirm | yes |
| `PATCH /workflows/:id/elements/:eid` | `element.update` | confirm | yes |
| `DELETE /workflows/:id/elements/:eid` | `element.remove` | confirm | yes |

## Flow Actions

| Endpoint | Action | Autonomy | Audited |
|----------|--------|----------|---------|
| `/act` direct | `flow.add` | confirm | yes |
| `/act` direct | `flow.remove` | confirm | yes |

## Trigger Actions

| Endpoint | Action | Autonomy | Audited |
|----------|--------|----------|---------|
| `PUT /workflows/:id/triggers/:eid` | `trigger.set` | confirm | yes |
| `POST /workflows/:id/triggers/:eid/resolve` | `trigger.resolve` | auto | yes |

## Case Actions

| Endpoint | Action | Autonomy | Audited |
|----------|--------|----------|---------|
| `POST /cases` | `case.start` | auto | yes |
| `GET /cases/:id` | `case.get` | auto | no |
| `GET /cases` | `case.list` | auto | no |
| `GET /workflows/:id/cases` | `case.list` | auto | no |
| `POST /cases/:id/close` | `case.close` | confirm | yes |
| `POST /cases/:id/cancel` | `case.cancel` | confirm | yes |
| `DELETE /cases/:id` | `case.delete` | confirm | yes |
| `POST /events/mining/case/:id/confirm-event` | `event.confirm` | auto | yes |

## Work Item Actions

| Endpoint | Action | Autonomy | Audited |
|----------|--------|----------|---------|
| `POST /workitems` | `workitem.create` | auto | yes |
| `POST /workitems/:id/complete` | `workitem.complete` | auto | yes |
| `PATCH /workitems/:id` | `workitem.update` | auto | yes |
| `GET /workitems` | `workitem.list` | auto | no |
| `DELETE /workitems/:id` | `workitem.cancel` | auto | yes |

## Role Actions

| Endpoint | Action | Autonomy | Audited |
|----------|--------|----------|---------|
| `POST /roles` | `role.create` | confirm | yes |
| `GET /roles` | `role.list` | auto | no |
| `PATCH /roles/:id` | `role.update` | confirm | yes |
| `DELETE /roles/:id` | `role.delete` | confirm | yes |

## Agent Actions

| Endpoint | Action | Autonomy | Audited |
|----------|--------|----------|---------|
| `POST /agents/register` | `agent.register` | auto | yes |
| `POST /agents/:id/start` | `agent.start` | confirm | yes |
| `POST /agents/:id/stop` | `agent.stop` | confirm | yes |
| `POST /agents/:id/restart` | `agent.restart` | confirm | yes |

## Subscription Actions

| Endpoint | Action | Autonomy | Audited |
|----------|--------|----------|---------|
| `POST /api/event-manager/subscribe` | `subscription.create` | auto | yes |
| `DELETE /api/event-manager/subscribe/:id` | `subscription.cancel` | auto | yes |
| `GET /api/event-manager/subscriptions` | `subscription.list` | auto | no |

## Reminder Actions

| Endpoint | Action | Autonomy | Audited |
|----------|--------|----------|---------|
| `POST /reminders` | `reminder.create` | auto | yes |
| `GET /reminders` | `reminder.list` | auto | no |
| `PATCH /reminders/:id/status` | `reminder.update_status` | auto | yes |
| `DELETE /reminders/:id` | `reminder.delete` | auto | yes |

## Message Actions

| Endpoint | Action | Autonomy | Audited |
|----------|--------|----------|---------|
| `POST /messages` | `message.send` | auto | yes |
| `GET /messages/:agentId` | `message.read` | auto | no |

## Audit Actions

| Endpoint | Action | Autonomy | Audited |
|----------|--------|----------|---------|
| `GET /audit` | `audit.read` | auto | no |

## Knowledge Actions

| Endpoint | Action | Autonomy | Audited |
|----------|--------|----------|---------|
| `GET /api/kb/tree` | `knowledge.tree` | auto | no |
| `GET /api/kb/file` | `knowledge.read` | auto | no |
| `GET /api/kb/search` | `knowledge.search` | auto | no |

## Universal Entry Point

`POST /act` accepts any action from the registry. See `docs/act-envelope.md` for envelope format.
