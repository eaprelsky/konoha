-- Konoha PostgreSQL schema (Phase 1 — shadow writes)
-- Created: 2026-04-06

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Workflows ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflows (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  version      TEXT NOT NULL DEFAULT '1.0.0',
  elements     JSONB NOT NULL DEFAULT '[]',
  flow         JSONB NOT NULL DEFAULT '[]',
  triggers     JSONB NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'active',
  parent_id    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
CREATE INDEX IF NOT EXISTS idx_workflows_parent_id ON workflows(parent_id);

-- ── Workflow snapshots (version history) ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  snapshot_num BIGINT NOT NULL,
  data         JSONB NOT NULL,
  saved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workflow_id, snapshot_num)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_workflow_id ON workflow_snapshots(workflow_id, snapshot_num);

-- ── Cases ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cases (
  case_id    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  process_id TEXT NOT NULL,
  version    TEXT,
  subject    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'active',
  position   TEXT,
  payload    JSONB NOT NULL DEFAULT '{}',
  history    JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cases_process_id ON cases(process_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_created_at ON cases(created_at DESC);

-- ── Work Items ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS work_items (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  case_id    TEXT,
  process_id TEXT,
  element_id TEXT,
  label      TEXT NOT NULL DEFAULT '',
  assignee   TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  input      JSONB NOT NULL DEFAULT '{}',
  output     JSONB NOT NULL DEFAULT '{}',
  deadline   TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
CREATE INDEX IF NOT EXISTS idx_work_items_assignee ON work_items(assignee);
CREATE INDEX IF NOT EXISTS idx_work_items_case_id ON work_items(case_id);
CREATE INDEX IF NOT EXISTS idx_work_items_process_id ON work_items(process_id);

-- ── Roles ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  description TEXT,
  assignees   JSONB NOT NULL DEFAULT '[]',
  strategy    TEXT NOT NULL DEFAULT 'manual',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Documents ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  name        TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT 'template',
  content     TEXT NOT NULL DEFAULT '',
  parameters  JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Reminders ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reminders (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  type         TEXT NOT NULL DEFAULT 'once',
  recipient    TEXT NOT NULL,
  message      TEXT NOT NULL DEFAULT '',
  scheduled_at TIMESTAMPTZ NOT NULL,
  channel      TEXT NOT NULL DEFAULT 'telegram',
  status       TEXT NOT NULL DEFAULT 'pending',
  case_id      TEXT,
  process_id   TEXT,
  element_id   TEXT,
  work_item_id TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
CREATE INDEX IF NOT EXISTS idx_reminders_scheduled_at ON reminders(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_reminders_recipient ON reminders(recipient);

-- ── Agent definitions ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_defs (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  model        TEXT,
  system_prompt TEXT,
  capabilities JSONB NOT NULL DEFAULT '[]',
  roles        JSONB NOT NULL DEFAULT '[]',
  tags         JSONB NOT NULL DEFAULT '[]',
  gender       TEXT DEFAULT 'neutral',
  avatar_url   TEXT,
  protected    BOOLEAN NOT NULL DEFAULT FALSE,
  tmux_session_override TEXT,
  extra        JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Skills ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS skills (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT '',
  name_en        TEXT,
  description    TEXT,
  prompt_snippet TEXT,
  tools          JSONB NOT NULL DEFAULT '[]',
  mcp_servers    JSONB NOT NULL DEFAULT '[]',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Konoha bus persistent data (Redis → PostgreSQL migration) ────────────────

CREATE TABLE IF NOT EXISTS konoha_agents (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL DEFAULT '',
  display_alias       TEXT,
  capabilities        JSONB NOT NULL DEFAULT '[]',
  roles               JSONB NOT NULL DEFAULT '[]',
  model               TEXT,
  status              TEXT NOT NULL DEFAULT 'online',
  last_heartbeat      BIGINT NOT NULL,
  event_subscriptions JSONB NOT NULL DEFAULT '[]',
  village_id          TEXT,
  address             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_konoha_agents_status ON konoha_agents(status);
CREATE INDEX IF NOT EXISTS idx_konoha_agents_last_heartbeat ON konoha_agents(last_heartbeat DESC);

CREATE TABLE IF NOT EXISTS konoha_tokens (
  token      TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES konoha_agents(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_konoha_tokens_agent_id ON konoha_tokens(agent_id);

CREATE TABLE IF NOT EXISTS konoha_invites (
  token       TEXT PRIMARY KEY,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_konoha_invites_expires_at ON konoha_invites(expires_at);
CREATE INDEX IF NOT EXISTS idx_konoha_invites_consumed_at ON konoha_invites(consumed_at);

CREATE TABLE IF NOT EXISTS konoha_messages (
  id          BIGSERIAL PRIMARY KEY,
  stream_id   TEXT,
  sender      TEXT NOT NULL,
  recipient   TEXT NOT NULL,
  channel     TEXT,
  type        TEXT NOT NULL DEFAULT 'message',
  text        TEXT NOT NULL DEFAULT '',
  reply_to    TEXT,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attachments JSONB NOT NULL DEFAULT '[]',
  village_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_konoha_messages_recipient_ts ON konoha_messages(recipient, timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_konoha_messages_channel_ts ON konoha_messages(channel, timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_konoha_messages_stream_id ON konoha_messages(stream_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_konoha_messages_recipient_stream_id
  ON konoha_messages(recipient, stream_id)
  WHERE stream_id IS NOT NULL;
