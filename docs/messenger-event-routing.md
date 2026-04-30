# Messenger Event Routing

`src/messenger-event-router.ts` is the first generic bridge from messenger
connector events to workflow triggers.

The path is:

1. Connector adapter normalizes a provider event into `NormalizedMessengerEvent`.
2. `messengerEventToWorkflowEvent()` maps it to a Konoha workflow event such as
   `telegram.message.received` with `source=telegram`.
3. `routeMessengerEventToWorkflows()` calls the existing workflow trigger path
   (`processEvent`) so matching workflow definitions create or advance cases.

The current Telegram stream bridge can keep publishing through `/events`; this
helper defines the connector-owned shape for new adapters without introducing a
sales-specific daemon. Sales workflows should match on workflow trigger filters
such as `chat_title`, `chat_ref`, `endpoint_id`, or `connector_id`.

Compatibility fields such as `telegram_stream`, `telegram_stream_id`,
`chat_id`, and `msg_id` are preserved in payloads so existing tests and
operational debugging remain stable.
