import { randomUUID } from "crypto";
import postgres from "postgres";
import type { Agent, Attachment, Message } from "../redis";
import { getDatabaseUrl } from "./database-url";

const DATABASE_URL = getDatabaseUrl();
const HEARTBEAT_TTL_MS = 600_000; // 10 minutes
const INVITE_TTL_SEC = 3600;

type JSONValue = Parameters<ReturnType<typeof postgres>["json"]>[0];
const asJson = (v: unknown): JSONValue => v as JSONValue;

let _sql: ReturnType<typeof postgres> | null = null;
let _schemaReady: Promise<void> | null = null;

function getSql(): ReturnType<typeof postgres> {
  if (!_sql) {
    _sql = postgres(DATABASE_URL, {
      max: 5,
      idle_timeout: 30,
      connect_timeout: 5,
      onnotice: () => {},
    });
  }
  return _sql;
}

export async function pgCloseBus(): Promise<void> {
  if (!_sql) return;
  await _sql.end();
  _sql = null;
  _schemaReady = null;
}

async function ensureBusSchema(): Promise<void> {
  if (_schemaReady) return _schemaReady;
  const sql = getSql();
  _schemaReady = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS konoha_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        display_alias TEXT,
        capabilities JSONB NOT NULL DEFAULT '[]',
        roles JSONB NOT NULL DEFAULT '[]',
        model TEXT,
        status TEXT NOT NULL DEFAULT 'online',
        last_heartbeat BIGINT NOT NULL,
        event_subscriptions JSONB NOT NULL DEFAULT '[]',
        village_id TEXT,
        address TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE konoha_agents ADD COLUMN IF NOT EXISTS display_alias TEXT`;
    await sql`
      CREATE TABLE IF NOT EXISTS konoha_tokens (
        token TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES konoha_agents(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_konoha_tokens_agent_id ON konoha_tokens(agent_id)`;
    await sql`
      CREATE TABLE IF NOT EXISTS konoha_invites (
        token TEXT PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS konoha_messages (
        id BIGSERIAL PRIMARY KEY,
        stream_id TEXT,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        channel TEXT,
        type TEXT NOT NULL DEFAULT 'message',
        text TEXT NOT NULL DEFAULT '',
        reply_to TEXT,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attachments JSONB NOT NULL DEFAULT '[]',
        village_id TEXT
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_konoha_messages_recipient_ts ON konoha_messages(recipient, timestamp DESC, id DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_konoha_messages_channel_ts ON konoha_messages(channel, timestamp DESC, id DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_konoha_messages_stream_id ON konoha_messages(stream_id)`;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_konoha_messages_recipient_stream_id
      ON konoha_messages(recipient, stream_id)
      WHERE stream_id IS NOT NULL
    `;
  })();
  return _schemaReady;
}

export async function pgRegisterAgent(agent: Agent): Promise<string> {
  await ensureBusSchema();
  const sql = getSql();
  const token = randomUUID();

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO konoha_agents (
        id, name, display_alias, capabilities, roles, model, status, last_heartbeat,
        event_subscriptions, village_id, address, updated_at
      )
      VALUES (
        ${agent.id},
        ${agent.name},
        ${agent.display_alias ?? null},
        ${tx.json(asJson(agent.capabilities ?? []))},
        ${tx.json(asJson(agent.roles ?? []))},
        ${agent.model ?? null},
        ${agent.status},
        ${agent.lastHeartbeat},
        ${tx.json(asJson(agent.eventSubscriptions ?? []))},
        ${agent.village_id ?? null},
        ${agent.address ?? null},
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        display_alias = EXCLUDED.display_alias,
        capabilities = EXCLUDED.capabilities,
        roles = EXCLUDED.roles,
        model = EXCLUDED.model,
        status = EXCLUDED.status,
        last_heartbeat = EXCLUDED.last_heartbeat,
        event_subscriptions = EXCLUDED.event_subscriptions,
        village_id = EXCLUDED.village_id,
        address = EXCLUDED.address,
        updated_at = NOW()
    `;

    await tx`DELETE FROM konoha_tokens WHERE agent_id = ${agent.id}`;
    await tx`INSERT INTO konoha_tokens (token, agent_id, created_at) VALUES (${token}, ${agent.id}, NOW())`;
  });

  return token;
}

export async function pgUpsertAgentSnapshot(agent: Agent): Promise<void> {
  await ensureBusSchema();
  const sql = getSql();

  await sql`
    INSERT INTO konoha_agents (
      id, name, display_alias, capabilities, roles, model, status, last_heartbeat,
      event_subscriptions, village_id, address, updated_at
    )
    VALUES (
      ${agent.id},
      ${agent.name},
      ${agent.display_alias ?? null},
      ${sql.json(asJson(agent.capabilities ?? []))},
      ${sql.json(asJson(agent.roles ?? []))},
      ${agent.model ?? null},
      ${agent.status},
      ${agent.lastHeartbeat},
      ${sql.json(asJson(agent.eventSubscriptions ?? []))},
      ${agent.village_id ?? null},
      ${agent.address ?? null},
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      display_alias = EXCLUDED.display_alias,
      capabilities = EXCLUDED.capabilities,
      roles = EXCLUDED.roles,
      model = EXCLUDED.model,
      status = EXCLUDED.status,
      last_heartbeat = EXCLUDED.last_heartbeat,
      event_subscriptions = EXCLUDED.event_subscriptions,
      village_id = EXCLUDED.village_id,
      address = EXCLUDED.address,
      updated_at = NOW()
  `;
}

export async function pgGetAgentIdByToken(token: string): Promise<string | null> {
  await ensureBusSchema();
  const sql = getSql();
  const rows = await sql<{ agent_id: string }[]>`
    SELECT agent_id FROM konoha_tokens WHERE token = ${token} LIMIT 1
  `;
  return rows[0]?.agent_id ?? null;
}

export async function pgCreateInvite(): Promise<{ token: string; expiresAt: string }> {
  await ensureBusSchema();
  const sql = getSql();
  const token = `inv-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + INVITE_TTL_SEC * 1000);

  await sql`
    INSERT INTO konoha_invites (token, expires_at, consumed_at, created_at)
    VALUES (${token}, ${expiresAt.toISOString()}, NULL, NOW())
    ON CONFLICT (token) DO UPDATE SET
      expires_at = EXCLUDED.expires_at,
      consumed_at = NULL
  `;

  return { token, expiresAt: expiresAt.toISOString() };
}

export async function pgConsumeInvite(token: string): Promise<boolean> {
  await ensureBusSchema();
  const sql = getSql();
  const rows = await sql<{ token: string }[]>`
    UPDATE konoha_invites
    SET consumed_at = NOW()
    WHERE token = ${token}
      AND consumed_at IS NULL
      AND expires_at > NOW()
    RETURNING token
  `;
  return rows.length > 0;
}

export async function pgUnregisterAgent(id: string, hard = false): Promise<void> {
  await ensureBusSchema();
  const sql = getSql();
  if (hard) {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM konoha_tokens WHERE agent_id = ${id}`;
      await tx`DELETE FROM konoha_agents WHERE id = ${id}`;
    });
    return;
  }
  await sql`
    UPDATE konoha_agents
    SET status = 'offline', updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function pgHeartbeat(id: string): Promise<void> {
  await ensureBusSchema();
  const sql = getSql();
  await sql`
    UPDATE konoha_agents
    SET status = 'online', last_heartbeat = ${Date.now()}, updated_at = NOW()
    WHERE id = ${id}
  `;
}

function mapRowToAgent(row: Record<string, unknown>, now: number): Agent {
  const lastHeartbeat = Number(row.last_heartbeat ?? 0);
  const stale = now - lastHeartbeat > HEARTBEAT_TTL_MS;
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    display_alias: row.display_alias ? String(row.display_alias) : undefined,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities as string[] : [],
    roles: Array.isArray(row.roles) ? row.roles as string[] : [],
    model: row.model ? String(row.model) : undefined,
    status: stale ? "offline" : (String(row.status ?? "offline") as Agent["status"]),
    lastHeartbeat,
    eventSubscriptions: Array.isArray(row.event_subscriptions) ? row.event_subscriptions as string[] : [],
    village_id: row.village_id ? String(row.village_id) : undefined,
    address: row.address ? String(row.address) : undefined,
  };
}

export async function pgListAgents(onlineOnly = false): Promise<Agent[]> {
  await ensureBusSchema();
  const sql = getSql();
  const now = Date.now();
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, name, display_alias, capabilities, roles, model, status, last_heartbeat, event_subscriptions, village_id, address
    FROM konoha_agents
    ORDER BY id ASC
  `;
  const agents = rows.map(r => mapRowToAgent(r, now));
  return onlineOnly ? agents.filter(a => a.status === "online") : agents;
}

export async function pgStoreMessage(msg: Message): Promise<boolean> {
  await ensureBusSchema();
  const sql = getSql();
  const rows = await sql<{ id: number }[]>`
    INSERT INTO konoha_messages (
      stream_id, sender, recipient, channel, type, text, reply_to, timestamp, attachments, village_id
    )
    VALUES (
      ${msg.id ?? null},
      ${msg.from},
      ${msg.to},
      ${msg.channel ?? null},
      ${msg.type},
      ${msg.text},
      ${msg.replyTo ?? null},
      ${msg.timestamp ?? new Date().toISOString()},
      ${sql.json(asJson(msg.attachments ?? []))},
      ${msg.village_id ?? null}
    )
    ON CONFLICT (recipient, stream_id) WHERE stream_id IS NOT NULL DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}

export async function pgReadHistory(target: string, count = 20): Promise<Message[]> {
  await ensureBusSchema();
  const sql = getSql();

  let rows = await sql<Record<string, unknown>[]>`
    SELECT stream_id, sender, recipient, channel, type, text, reply_to, timestamp, attachments, village_id
    FROM konoha_messages
    WHERE recipient = ${target}
    ORDER BY timestamp DESC, id DESC
    LIMIT ${count}
  `;

  if (rows.length === 0) {
    rows = await sql<Record<string, unknown>[]>`
      SELECT stream_id, sender, recipient, channel, type, text, reply_to, timestamp, attachments, village_id
      FROM konoha_messages
      WHERE channel = ${target}
      ORDER BY timestamp DESC, id DESC
      LIMIT ${count}
    `;
  }

  return rows.reverse().map((row) => ({
    id: row.stream_id ? String(row.stream_id) : undefined,
    from: String(row.sender),
    to: String(row.recipient),
    channel: row.channel ? String(row.channel) : undefined,
    type: (String(row.type ?? "message") as Message["type"]),
    text: String(row.text ?? ""),
    replyTo: row.reply_to ? String(row.reply_to) : undefined,
    timestamp: row.timestamp ? new Date(String(row.timestamp)).toISOString() : undefined,
    attachments: Array.isArray(row.attachments) ? row.attachments as Attachment[] : undefined,
    village_id: row.village_id ? String(row.village_id) : undefined,
  }));
}

export async function pgListChannels(): Promise<string[]> {
  await ensureBusSchema();
  const sql = getSql();
  const rows = await sql<{ channel: string }[]>`
    SELECT DISTINCT channel
    FROM konoha_messages
    WHERE channel IS NOT NULL AND channel <> ''
    ORDER BY channel ASC
  `;
  return rows.map(r => r.channel);
}

/**
 * Flush stale agent statuses to PG. Agents whose last heartbeat is older than
 * HEARTBEAT_TTL_MS and still show as 'online' are marked 'offline'.
 * Called periodically by the Tsunade healthcheck timer.
 * Returns the number of agents marked offline.
 */
export async function pgFlushStaleAgents(): Promise<number> {
  await ensureBusSchema();
  const sql = getSql();
  const cutoff = Date.now() - HEARTBEAT_TTL_MS;
  const rows = await sql<{ id: string }[]>`
    UPDATE konoha_agents
    SET status = 'offline', updated_at = NOW()
    WHERE status = 'online' AND last_heartbeat < ${cutoff}
    RETURNING id
  `;
  return rows.length;
}
