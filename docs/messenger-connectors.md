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

## Future Routing

One connector can own multiple endpoints, and each endpoint can bind chats to
different workflows or agents. For example, a sales Telegram connector can send
direct bot chats to `lead-intake`, group messages to `support-triage`, and still
delegate ambiguous messages to an agent or role.

Credentials remain outside the model. `account_ref` points to an env var,
profile, or future secret-store key; it must not contain raw tokens.
