# Configuration Reference

All configuration is done through environment variables. In production they are set in `/home/ubuntu/.agent-env` (loaded by all systemd services). In development, create a `.env` file in the project root.

---

## Core

| Variable | Default | Description |
|---|---|---|
| `KONOHA_TOKEN` | `konoha-dev-token` | Admin token for API auth. Set in Nginx `auth_request`. Also used by MCP clients. |
| `KONOHA_URL` | `http://127.0.0.1:3100` | Internal URL of the Konoha server (used by MCP). |
| `KONOHA_PUBLIC_URL` | `http://localhost:3200` | Public-facing URL (used for webhook URLs in trigger config). |
| `KONOHA_SETUP_FILE` | `/opt/shared/.konoha-setup.json` | Path to the setup JSON written by the Setup Wizard. |
| `KONOHA_REPO` | `eaprelsky/konoha` | GitHub repository for issue creation by agents. |

---

## Database

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://...` (local) | PostgreSQL connection string. |
| `REDIS_DB` | `0` | Redis database index. Tests use DB 1 to avoid polluting production data. |
| `PG_READ` | `false` | Set to `true` to enable Phase 2 migration: read cases/work-items from PostgreSQL instead of Redis. |

---

## AI / LLM

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key. Used by normalizer, trigger resolver, AI chat endpoint, and KB. |

---

## Telegram

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Token for the Telegram bot adapter (Grammy-based). Required for `telegram-bot` trigger type. |
| `TG_SEND_SCRIPT` | `/home/ubuntu/naruto-tg-send.py` | Path to the Python script used by the dispatcher to send Telegram messages to persons. |

---

## GitHub

| Variable | Source | Description |
|---|---|---|
| `GH_TOKEN` | `~/.github-token` (fallback) | GitHub Personal Access Token. Used for issue creation and deploy routes. |
| `GITHUB_WEBHOOK_SECRET` | — | Optional HMAC secret for validating incoming GitHub webhook payloads. |

---

## Adapters

| Variable | Default | Description |
|---|---|---|
| `BITRIX24_WEBHOOK_URL` | — | Bitrix24 REST webhook URL for the Bitrix24 chatbot adapter. |
| `CHATBOT_BITRIX_WEBHOOK` | — | Bitrix24 webhook for the legacy Bitrix adapter. |
| `CHATBOT_SMTP_HOST` | `mail.eaprelsky.ru` | SMTP server for the email adapter. |
| `CHATBOT_SMTP_PORT` | `587` | SMTP port. |
| `CHATBOT_SMTP_USER` | — | SMTP username. |
| `CHATBOT_SMTP_PASSWORD` | — | SMTP password. |
| `REPLICATE_API_TOKEN` | — | Replicate API token for the image generation adapter. |
| `TRACKER_TOKEN` | — | Yandex Tracker OAuth token. |
| `TRACKER_CLOUD_ORG_ID` | — | Yandex Tracker cloud organisation ID. |
| `YONOTE_BASE_URL` | `https://comindspace.yonote.ru` | Yonote base URL for the Yonote adapter. |
| `YONOTE_API_KEY` | — | Yonote API key. |

---

## MCP / Agent

| Variable | Default | Description |
|---|---|---|
| `KONOHA_AGENT_TOKEN` | — | Per-agent token (set by the lifecycle manager on agent startup). Identifies the agent to the server. |
| `KONOHA_SKILLS` | — | Comma-separated list of skill IDs enabled for this MCP client instance. |
| `TESTBENCH_URL` | `http://127.0.0.1:3201` | URL of the TestBench Chromium service. Used by the `testbench-proxy` route and MCP tools. |

---

## Minimal production `.env`

```env
KONOHA_TOKEN=<strong-random-token>
ANTHROPIC_API_KEY=sk-ant-api03-...
DATABASE_URL=postgresql://konoha:password@localhost:5432/konoha
TELEGRAM_BOT_TOKEN=<bot-token>
GH_TOKEN=ghp_...
KONOHA_REPO=yourorg/konoha
KONOHA_PUBLIC_URL=https://your-domain.com
```
