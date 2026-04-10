# Adapters

Adapters in `src/adapters/` connect Konoha workflows to external services. Each adapter implements a common interface and is registered in the workflow engine.

## Available adapters

| Adapter | File | Purpose |
|---------|------|---------|
| Telegram | `telegram.ts` | Send messages via Telegram Bot API |
| Bitrix24 | `bitrix24.ts` | Create/update leads and deals in Bitrix24 CRM |
| Tracker | `tracker.ts` | Create and update issues in Yandex Tracker |
| Yonote | `yonote.ts` | Read/write pages in Yonote knowledge base |
| Email | `email.ts` | Send email via SMTP |
| Image | `image.ts` | Generate or process images |
| HTTP | `http.ts` | Generic HTTP requests to external APIs |
| Redis | `redis.ts` | Publish/subscribe and key-value operations |
| Konoha | `konoha.ts` | Inter-agent messaging via Konoha bus |
| GitHub | `github.ts` | Create/update issues and PRs on GitHub |
| Calendar | `calendar.ts` | Read/write events in calendar services |

## Configuration

Each adapter reads its credentials from environment variables or `/opt/shared/.shared-credentials`. See individual adapter source files in `src/adapters/` for specific variable names.

## Adding a new adapter

1. Create `src/adapters/<name>.ts` implementing the `Adapter` interface
2. Register it in `src/adapters/index.ts`
3. Add credentials documentation here and to `/opt/shared/.shared-credentials.example`
