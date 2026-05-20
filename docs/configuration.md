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

## Dashboard Auth

| Variable | Default | Description |
|---|---|---|
| `KONOHA_DASHBOARD_USER` | `admin` | Dashboard login username. |
| `KONOHA_DASHBOARD_PASSWORD` | — | One-time bootstrap password. On successful login the backend writes a hashed password file; do not keep this in long-lived env if not needed. |
| `KONOHA_DASHBOARD_AUTH_FILE` | `/opt/shared/.dashboard-auth.json` | Local hashed dashboard credential file. Must be mode `0600`. |
| `KONOHA_DASHBOARD_HOSTS` | — | Comma-separated dashboard hostnames. Requests for these hosts require the dashboard session cookie and cannot authenticate with bearer token alone. |
| `KONOHA_SESSION_SECRET` | `KONOHA_TOKEN` | Optional signing secret for dashboard session cookies. |

---

## Database

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://...` (local) | PostgreSQL connection string. |
| `REDIS_DB` | `0` | Redis database index. Runtime defaults to DB 0; Bun tests set an isolated non-zero DB through `tests/setup.ts`. |
| `PG_READ` | `false` | Set to `true` to enable Phase 2 migration: read cases/work-items from PostgreSQL instead of Redis. |

---

## AI / LLM

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key. Used by normalizer, trigger resolver, AI chat endpoint, and KB. |
| `OPENROUTER_API_KEY` | Yes for Telegram router/packers | Primary OpenRouter key. |
| `OPENROUTER_API_KEYS` | No | Optional comma-separated OpenRouter keys used after the primary key. |
| `OPENROUTER_API_KEY_FALLBACK_1..5` | No | Optional fallback OpenRouter keys. Used when the primary key returns auth/payment/rate-limit/server errors or a network error. |

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

## Shared Config Validation

Production shared config is validated by:

```bash
python3 scripts/validate-shared-config.py --require-credentials --require-trusted-users
```

The validator checks `/opt/shared/.shared-credentials` and `/opt/shared/.trusted-users.json` without printing secret values. It fails on malformed env lines, shell syntax errors, conflicting duplicate keys, missing/empty required keys, invalid trust JSON, and an empty trusted-user list.

Allowed duplicate keys are documented in the validator: `SERVICE_ACCOUNT_PATH` and `DRIVE_FOLDER_ID` may appear twice only when both values are identical. All other duplicate keys must be removed.

---

## MCP / Agent

| Variable | Default | Description |
|---|---|---|
| `KONOHA_AGENT_TOKEN` | — | Per-agent token (set by the lifecycle manager on agent startup). Identifies the agent to the server. |
| `KONOHA_SKILLS` | — | Comma-separated list of skill IDs enabled for this MCP client instance. |
| `TESTBENCH_URL` | `http://127.0.0.1:3203` | URL of the TestBench Chromium service. Used by the `testbench-proxy` route and MCP tools. |
| `TESTBENCH_MODE` | `on-demand` | TestBench lifecycle mode reported in `/testbench/status`; persistent debug use must be explicit. |
| `TESTBENCH_POOL_SIZE` | `1` | Number of warmed BrowserContext sessions for the bounded TestBench service. |
| `TESTBENCH_MAX_POOL_SIZE` | `2` | Hard cap for BrowserContext sessions; the service clamps requested pool size to this value. |
| `TESTBENCH_MAX_CONCURRENT_JOBS` | `2` | Maximum active plus queued TestBench jobs before the service rejects new work. |
| `TESTBENCH_ACQUIRE_TIMEOUT_MS` | `20000` | Maximum wait for a free TestBench session. |
| `TESTBENCH_REQUEST_TIMEOUT_MS` | `30000` | Default browser navigation/request timeout for TestBench actions. |
| `TESTBENCH_SESSION_TTL_MS` | `300000` | Idle BrowserContext TTL before TestBench recreates the session on next acquire. |
| `KONOHA_MCP_SESSION_PACKS` | — | Comma-separated on-demand MCP packs to attach through `scripts/build-mcp-session-config.ts`. Persistent startup always uses startup mode and still defers lazy packs. |
| `KONOHA_MCP_ON_DEMAND_IDLE_TIMEOUT_SEC` | `900` | Idle timeout for stdio on-demand MCP wrappers such as `puppeteer`. |
| `KONOHA_SHARED_MCP_CONFIG_PATH` | `/opt/shared/comind-template/.mcp.json:/home/ubuntu/.mcp.json` | Optional colon-separated override for shared MCP config resolution, mainly for tests/diagnostics. |

---

## Feature Flags

The feature catalog lives in `docs/feature-flags.json`. Service-profile defaults
come from `docs/service-profiles.json`; `prod-core` and `staging-core` keep all
experimental product surfaces disabled by default. Disabled routes return an
intentional JSON `404`, disabled UI surfaces are hidden from navigation, and
healthcheck reports disabled experiments as intentional.

| Variable | Default | Description |
|---|---|---|
| `KONOHA_SERVICE_PROFILE` | `prod-core` | Selects service-profile defaults for connectors, agents, monitors, and feature flags. |
| `KONOHA_FEATURE_PROFILE` | `KONOHA_SERVICE_PROFILE` | Optional feature-only profile override. |
| `KONOHA_FEATURE_FLAGS_FILE` | `/opt/shared/konoha-feature-flags.json` | Optional JSON override file. Use `features.<id>.enabled`, `enabled_by`, and `reason` to record who enabled an experiment and why. |
| `KONOHA_ENABLED_FEATURES` | — | Comma-separated emergency/dev override for enabling feature flags. Pair with `KONOHA_FEATURE_ENABLE_REASON`. |
| `KONOHA_DISABLED_FEATURES` | — | Comma-separated override that disables feature flags after profile/file/env enablement. |
| `KONOHA_FEATURE_ENABLE_REASON` | — | Audit reason attached to `KONOHA_ENABLED_FEATURES`. |

Example override:

```json
{
  "features": {
    "corporate-memory": {
      "enabled": true,
      "enabled_by": "operator:yegor",
      "reason": "Time-boxed Jiraiya/KB acceptance check"
    }
  }
}
```

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
