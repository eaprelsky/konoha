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

## Activation Policy

Messenger-driven workflow starts must declare an `activation_policy` on the
workflow trigger or the start event trigger before `workflow.deploy` can mark
the workflow executable. The policy is evaluated after the deterministic
connector/workflow filters match and before a case is created.

Supported controls:

| Control | Purpose |
|---|---|
| `min_confidence` + `confidence_field` | Suppress low-confidence events before they create cases. |
| `dedup_window_sec` + `dedup_fields` | Suppress duplicate provider deliveries using source-stable keys such as `connector_id`, `endpoint_id`, `chat_ref`, and `message_id`. |
| `rate_limit` | Throttle bursts by workflow, connector, endpoint, chat, or source scope. |
| `backpressure.max_running_cases` | Stop creating new cases when the target workflow already has too many running cases. |
| `sampling.rate` | Deterministically sample noisy streams when full capture is not required. |
| `inspect_suppressed` | Keep suppressed/throttled events inspectable. Defaults to enabled. |

Structured reason codes are emitted for suppressed activations:
`LOW_CONFIDENCE`, `DUPLICATE`, `RATE_LIMITED`, `BACKPRESSURE`,
`SAMPLED_OUT`, `ACTIVATION_DISABLED`, and `UNMATCHED_TRIGGER`.
Inspectable suppressions are stored in the capped Redis stream
`konoha:workflow:event-activation:suppressed` with workflow id, event type,
source, reason code, action, detail, payload snapshot, and timestamp. This keeps
operator visibility without allowing noisy messenger streams to create
unbounded cases or UI artifacts.

Example:

```json
{
  "event_type": "telegram.message.received",
  "start_node": "e1",
  "activation_policy": {
    "min_confidence": 0.6,
    "confidence_field": "router_confidence",
    "dedup_window_sec": 3600,
    "dedup_fields": ["connector_id", "endpoint_id", "chat_ref", "message_id"],
    "rate_limit": {
      "window_sec": 60,
      "max_events": 30,
      "scope": ["workflow", "connector", "chat"]
    },
    "backpressure": { "max_running_cases": 200 },
    "inspect_suppressed": true
  }
}
```

## Deterministic Router

Before workflow scoping, Konoha applies a small deterministic classifier to the
normalized payload. It is intentionally cheap and non-LLM:

| Derived field | Source |
|---|---|
| `message_type=command` | text starts with `/command` or `/command@bot` |
| `message_type=text` | non-empty text without a command |
| `message_type=reaction` | `event_kind=reaction` |
| `message_type=photo` / `document` | matching `event_kind` |
| `command` | lower-cased command without `/` or bot suffix |

Routing rules can match `message_type` and `command` in addition to
`endpoint_id`, `chat_id`, and `chat_type`. This gives us a stable pre-filter for
busy chats before any optional LLM classifier is introduced.
