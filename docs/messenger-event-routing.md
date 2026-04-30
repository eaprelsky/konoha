# Messenger Event Routing

`src/messenger-event-router.ts` and `scripts/telegram-event-bridge.py` are the
first generic bridge from messenger connector events to workflow triggers.

The path is:

1. Connector adapter normalizes a provider event into `NormalizedMessengerEvent`.
2. `messengerEventToWorkflowEvent()` maps it to a Konoha workflow event such as
   `telegram.message.received` with `source=telegram`.
3. `routeMessengerEventToWorkflows()` calls the existing workflow trigger path
   (`processEvent`) so matching workflow definitions create or advance cases.

The current Telegram stream bridge publishes through `/events` using the same
connector-owned payload shape. It intentionally contains no sales-specific
routing logic. Sales workflows should match on workflow trigger filters such as
`chat_title`, `chat_ref`, `endpoint_id`, or `connector_id`.

Current normalized Telegram payload fields:

| Field | Purpose |
|---|---|
| `provider` | Messenger provider, currently `telegram`. |
| `connector_id` | Connector id, default `telegram-main`. |
| `endpoint_id` | Endpoint id such as `telegram-user-sasuke` or `telegram-bot-naruto`. |
| `event_kind` | `message` or `reaction`. |
| `chat_ref` | Provider chat reference, usually Telegram `chat_id`. |
| `chat_type` | `direct`, `group`, `channel`, or `unknown`. |
| `message_id` | Provider message id, copied from `msg_id` or `message_id`. |
| `sender_ref` | Provider sender id, copied from `sender_id`, `from_id`, or `user_id`. |
| `sender_name` | Human-readable sender name when available. |
| `timestamp` | Provider timestamp when available. |

The compatibility bridge infers `endpoint_id` from `target_stream` first, then
from the configured Redis stream. `TELEGRAM_EVENT_ENDPOINT_ID` can override the
endpoint for dedicated bridge instances.

Compatibility fields such as `telegram_stream`, `telegram_stream_id`,
`chat_id`, and `msg_id` are preserved in payloads so existing tests and
operational debugging remain stable.

## Workflow Scope

`POST /events` resolves Telegram connector metadata against the messenger
catalog before calling the workflow runtime. If a matching chat binding, rule,
or workflow target explicitly enables workflow ids, the runtime only evaluates
those workflows for the event. If no explicit workflow scope is configured, the
legacy behavior is preserved and all workflow triggers can match normally.

This makes the migration compatibility-safe: the current sales process can keep
matching `coMind Лиды` through its eEPC trigger filter, while dedicated chat
bindings can progressively narrow events to specific workflows.
