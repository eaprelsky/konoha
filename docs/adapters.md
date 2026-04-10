# Adapters

Adapters in `src/adapters/` connect Konoha workflows to external services. Each adapter implements a common interface and is registered in the workflow engine.

## Available adapters

| Adapter | File | Purpose |
|---------|------|---------|
| DataAdapter (interface) | `data-adapter.ts` | Base interface for all adapters (EventListener + EventEmitter) |
| Telegram (Telethon) | `telegram.ts` | Send messages via Telegram user account (Telethon) |
| Telegram Bot | `telegram-bot.ts` | Read from `telegram:bot:incoming` Redis stream via Grammy bot |
| Bitrix24 | `bitrix24.ts` | Create/update leads and deals in Bitrix24 CRM |
| Bitrix (webhooks) | `bitrix.ts` | Incoming Bitrix24 webhooks via REST event.bind |
| Tracker | `tracker.ts` | Create and update issues in Yandex Tracker |
| Yandex Tracker | `yandex-tracker.ts` | Yandex Tracker adapter (TRACKER_TOKEN, TRACKER_CLOUD_ORG_ID) |
| Yonote | `yonote.ts` | Read/write pages in Yonote knowledge base |
| Email | `email.ts` | Send email via SMTP |
| Image | `image.ts` | Generate or process images |

## Configuration

Each adapter reads its credentials from environment variables or `/opt/shared/.shared-credentials`. See individual adapter source files in `src/adapters/` for specific variable names.

## Adding a new adapter

1. Create `src/adapters/<name>.ts` implementing the `Adapter` interface
2. Register it in `src/adapters/index.ts`
3. Add credentials documentation here and to `/opt/shared/.shared-credentials.example`
