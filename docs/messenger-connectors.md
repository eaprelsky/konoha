# Messenger Connectors

Messenger connectors separate accounts and bots from autonomous agents. A
connector describes transport and routing; agents remain runtime workers that
may receive delegated work from that routing policy.

## Entity Model

| Entity | Purpose |
|---|---|
| `messenger_connector` | Provider-level connector such as Telegram, with enabled state and endpoint ids. |
| `messenger_endpoint` | One bot, user account, webhook, or business account under the connector. |
| `chat_binding` | Mapping from a chat/channel/group reference to a routing policy and enabled workflows. |
| `routing_policy` | Rules that route inbound messages to workflows, agents, or roles. |

The first code model is in `src/messenger-connectors.ts`. `GET
/connectors/messenger` exposes a read-only skeleton for admins.

## Telegram Compatibility

Current runtime ids stay unchanged:

| Endpoint | Runtime id | Streams |
|---|---|---|
| `telegram-bot-naruto` | `naruto` | `telegram:bot:incoming` / group `naruto` |
| `telegram-user-sasuke` | `sasuke` | `telegram:incoming` / group `sasuke`, `telegram:reaction_updates` / group `sasuke-reactions` |

These records are compatibility records only. They do not rename systemd units,
tmux sessions, Redis streams, or watchdogs.

`telegram-event-bridge.py` now publishes connector-normalized workflow events
while preserving the existing Redis streams. The compatibility defaults are:

| Setting | Default | Notes |
|---|---|---|
| `TELEGRAM_EVENT_CONNECTOR_ID` | `telegram-main` | Connector id added to every `/events` payload. |
| `TELEGRAM_EVENT_ENDPOINT_ID` | inferred | Optional override for dedicated bridge instances. |
| `target_stream=telegram:bot:incoming` | `telegram-bot-naruto` | Bot endpoint inference. |
| `target_stream=telegram:incoming` or `telegram:log` | `telegram-user-sasuke` | User-account endpoint inference. |

The endpoint names are compatibility ids. Business workflows should depend on
roles, documents, workflow triggers, and connector metadata, not on Naruto/Sasuke
as business actors.

## Outbound Messages

Outbound connector delivery is exposed through Action Spine as
`connector.send_message`. The action accepts `connector_id`, `endpoint_id`,
`chat_ref`, `text`, optional `reply_to`, optional `parse_mode`, optional
`metadata`, and `dry_run`.

For the Telegram compatibility connector the action validates the endpoint
against `telegram-main` and publishes connector-normalized entries to
`telegram:outgoing`:

| Field | Purpose |
|---|---|
| `connector_id` | Connector used for delivery. |
| `endpoint_id` | Bot/user-account endpoint used for delivery. |
| `chat_ref` / `chat_id` | Provider chat reference. |
| `text` | Outbound message body. |
| `source_action` | `connector.send_message` for audit/debug. |
| `metadata` | Optional case/work item/workflow context. |

`dry_run=true` validates and returns the exact outbound entry without writing to
Redis. This is the preferred mode for agents and tests before an actual external
send is confirmed.

## Future Routing

One connector can own multiple endpoints, and each endpoint can bind chats to
different workflows or agents. For example, a sales Telegram connector can send
direct bot chats to `lead-intake`, group messages to `support-triage`, and still
delegate ambiguous messages to an agent or role.

Credentials remain outside the model. `account_ref` points to an env var,
profile, or future secret-store key; it must not contain raw tokens.
