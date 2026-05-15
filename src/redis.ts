import Redis from "ioredis";
import { config } from "./config";
import { createLogger, silentCatch } from "./logger";
import {
  pgRegisterAgent,
  pgGetAgentIdByToken,
  pgCreateInvite,
  pgConsumeInvite,
  pgUnregisterAgent,
  pgHeartbeat,
  pgListAgents,
  pgStoreMessage,
  pgReadHistory,
  pgListChannels,
} from "./storage/pg-bus";
const log = createLogger("redis");

const BUS_STREAM = "konoha:bus";
export const AGENT_STREAM_PREFIX = "konoha:agent:";
const CHANNEL_STREAM_PREFIX = "konoha:channel:";
const EVENTS_STREAM = "konoha:events";

export const DEFAULT_VILLAGE = "comind.konoha";

export interface Agent {
  id: string;
  name: string;
  display_alias?: string;
  capabilities: string[];
  roles: string[];
  model?: string;
  status: "online" | "offline";
  lastHeartbeat: number;
  token?: string; // returned on registration, not stored in registry
  eventSubscriptions?: string[]; // event types this agent wants to receive
  village_id?: string; // e.g. "comind.konoha"; defaults to DEFAULT_VILLAGE
  address?: string;   // canonical address: id@village_id
}

export interface KonohaEvent {
  type: string;       // e.g. "lead.qualified"
  source: string;     // e.g. "chatbot@comind.konoha"
  payload: Record<string, unknown>;
  timestamp: string;  // ISO 8601
  village_id: string; // e.g. "comind.konoha"
}

export interface Attachment {
  name: string;        // original filename
  path: string;        // absolute path in shared storage
  mime?: string;        // MIME type
  size?: number;        // bytes
}

export interface Message {
  id?: string;
  from: string;  // agent id or agent@village.konoha
  to: string;    // agent id, "all", "role:<role>", or agent@village.konoha
  channel?: string;
  type: "message" | "task" | "result" | "status" | "event" | "event_fired";
  text: string;
  replyTo?: string;
  timestamp?: string;
  attachments?: Attachment[];
  village_id?: string; // originating village; defaults to DEFAULT_VILLAGE
}

const REDIS_DB = Number.isFinite(config.storage.redisDb) ? config.storage.redisDb : 0;

export function createRedis(): Redis {
  const r = new Redis({ host: "127.0.0.1", port: 6379, db: REDIS_DB, maxRetriesPerRequest: 3, lazyConnect: false });
  r.on("error", (err) => {
    log.error("redis error", { error: err.message });
  });
  return r;
}

export const REDIS_CONNECTION_OPTS = { host: "127.0.0.1", port: 6379, db: REDIS_DB };

export const redis = createRedis();
export const redisSub = createRedis(); // separate connection for blocking reads

export async function registerAgent(agent: Omit<Agent, "status" | "lastHeartbeat" | "token" | "address">): Promise<Agent> {
  const village_id = agent.village_id || DEFAULT_VILLAGE;
  const stored: Agent = {
    ...agent,
    village_id,
    address: `${agent.id}@${village_id}`,
    eventSubscriptions: agent.eventSubscriptions ?? [],
    status: "online",
    lastHeartbeat: Date.now(),
  };
  const agentToken = await pgRegisterAgent(stored);

  // ensure consumer group exists for this agent
  const agentStream = AGENT_STREAM_PREFIX + agent.id;
  try {
    await redis.xgroup("CREATE", agentStream, agent.id, "0", "MKSTREAM");
  } catch (e: any) {
    if (!e.message?.includes("BUSYGROUP")) throw e;
  }

  // ensure consumer group on bus
  try {
    await redis.xgroup("CREATE", BUS_STREAM, agent.id, "$", "MKSTREAM");
  } catch (e: any) {
    if (!e.message?.includes("BUSYGROUP")) throw e;
  }
  return { ...stored, token: agentToken };
}

export async function getAgentIdByToken(token: string): Promise<string | null> {
  return pgGetAgentIdByToken(token);
}

export async function createInvite(): Promise<{ token: string; expiresAt: string }> {
  return pgCreateInvite();
}

export async function consumeInvite(token: string): Promise<boolean> {
  return pgConsumeInvite(token);
}

export async function unregisterAgent(id: string, hard = false): Promise<void> {
  await pgUnregisterAgent(id, hard);
  if (hard) {
    await redis.hdel("konoha:registry", id);
  }
}

export async function heartbeat(id: string): Promise<void> {
  await pgHeartbeat(id);
}

export async function listAgents(onlineOnly = false): Promise<Agent[]> {
  return pgListAgents(onlineOnly);
}

const NOTIFY_PREFIX = "konoha:notify:";

export async function sendMessage(msg: Message): Promise<string> {
  const entry: Record<string, string> = {
    from: msg.from,
    to: msg.to,
    type: msg.type,
    text: msg.text,
    timestamp: msg.timestamp || new Date().toISOString(),
    village_id: msg.village_id || DEFAULT_VILLAGE,
  };
  if (msg.channel) entry.channel = msg.channel;
  if (msg.replyTo) entry.replyTo = msg.replyTo;
  if (msg.attachments && msg.attachments.length > 0) {
    entry.attachments = JSON.stringify(msg.attachments);
  }

  // publish to bus stream (for broadcast/logging)
  const id = (await redis.xadd(BUS_STREAM, "*", ...Object.entries(entry).flat())) ?? "";

  // route to recipients
  if (msg.to === "all") {
    // broadcast: write to each online agent's stream (except sender)
    // Test agents (rtest- prefix) are isolated from production agents in fanout
    const agents = await listAgents(true);
    const senderIsTest = msg.from.startsWith("rtest-");
    const targets = agents.filter(a => a.id !== msg.from && senderIsTest === a.id.startsWith("rtest-"));
    if (targets.length > 0) {
      for (const agent of targets) {
        const sid = await redis.xadd(AGENT_STREAM_PREFIX + agent.id, "*", ...Object.entries(entry).flat());
        await redis.publish(NOTIFY_PREFIX + agent.id, JSON.stringify({ ...entry, _sid: sid }));
        await pgStoreMessage({
          id: sid ?? undefined,
          from: msg.from,
          to: agent.id,
          type: msg.type,
          text: msg.text,
          channel: msg.channel,
          replyTo: msg.replyTo,
          timestamp: entry.timestamp,
          attachments: msg.attachments,
          village_id: entry.village_id,
        });
      }
    }
  } else if (msg.to.startsWith("role:")) {
    // role-based routing
    const role = msg.to.slice(5);
    const agents = await listAgents(true);
    const targets = agents.filter(a => a.roles.includes(role) && a.id !== msg.from);
    if (targets.length > 0) {
      for (const agent of targets) {
        const sid = await redis.xadd(AGENT_STREAM_PREFIX + agent.id, "*", ...Object.entries(entry).flat());
        await redis.publish(NOTIFY_PREFIX + agent.id, JSON.stringify({ ...entry, _sid: sid }));
        await pgStoreMessage({
          id: sid ?? undefined,
          from: msg.from,
          to: agent.id,
          type: msg.type,
          text: msg.text,
          channel: msg.channel,
          replyTo: msg.replyTo,
          timestamp: entry.timestamp,
          attachments: msg.attachments,
          village_id: entry.village_id,
        });
      }
    }
  } else {
    // direct message: capture stream ID and include in pub/sub so SSE clients can track position
    const streamId = await redis.xadd(AGENT_STREAM_PREFIX + msg.to, "*", ...Object.entries(entry).flat());
    await redis.publish(NOTIFY_PREFIX + msg.to, JSON.stringify({ ...entry, _sid: streamId }));
    await pgStoreMessage({
      id: streamId ?? undefined,
      from: msg.from,
      to: msg.to,
      type: msg.type,
      text: msg.text,
      channel: msg.channel,
      replyTo: msg.replyTo,
      timestamp: entry.timestamp,
      attachments: msg.attachments,
      village_id: entry.village_id,
    });
  }

  // channel routing
  if (msg.channel) {
    await redis.xadd(CHANNEL_STREAM_PREFIX + msg.channel, "*", ...Object.entries(entry).flat());
  }

  return id;
}

// Ensure a consumer group exists on a stream.
// For fan-out: each (agentId, consumer) pair gets its own group so all consumers receive all messages.
async function ensureGroup(stream: string, group: string): Promise<void> {
  try {
    await redis.xgroup("CREATE", stream, group, "0", "MKSTREAM");
  } catch (e: any) {
    if (!e.message?.includes("BUSYGROUP")) throw e;
  }
}

// Read messages for an agent. If consumer is provided, uses a per-consumer group (fan-out).
// Auto-acks after delivery. For explicit ack control, use readMessagesPending + ackMessages.
export async function readMessages(agentId: string, count = 10, consumer?: string): Promise<Message[]> {
  const stream = AGENT_STREAM_PREFIX + agentId;
  // Fan-out: each unique consumer gets its own group starting from "0" so it sees all messages.
  // Without consumer param: legacy behavior — group = agentId, consumer = agentId (competing).
  const group = consumer ? `${agentId}:${consumer}` : agentId;
  const consumerName = consumer || agentId;

  await ensureGroup(stream, group);

  const messages: Message[] = [];

  // 1. Re-deliver pending (unacked from previous poll)
  const pending = await redis.xreadgroup(
    "GROUP", group, consumerName, "COUNT", count, "STREAMS", stream, "0"
  ) as [string, [string, string[]][]][] | null;

  if (pending) {
    for (const [, entries] of pending) {
      for (const [id, fields] of entries) {
        if (!fields || fields.length === 0) continue;
        messages.push(fieldsToMessage(id, fields));
        await redis.xack(stream, group, id);
      }
    }
  }

  // 2. Read new messages
  const remaining = count - messages.length;
  if (remaining > 0) {
    const fresh = await redis.xreadgroup(
      "GROUP", group, consumerName, "COUNT", remaining, "STREAMS", stream, ">"
    ) as [string, [string, string[]][]][] | null;

    if (fresh) {
      for (const [, entries] of fresh) {
        for (const [id, fields] of entries) {
          messages.push(fieldsToMessage(id, fields));
          await redis.xack(stream, group, id);
        }
      }
    }
  }

  return messages;
}

// Read pending (unacknowledged) messages without auto-ack.
export async function readMessagesPending(agentId: string, consumer: string, count = 10): Promise<Message[]> {
  const stream = AGENT_STREAM_PREFIX + agentId;
  const group = `${agentId}:${consumer}`;
  await ensureGroup(stream, group);

  const pending = await redis.xreadgroup(
    "GROUP", group, consumer, "COUNT", count, "STREAMS", stream, "0"
  ) as [string, [string, string[]][]][] | null;

  const messages: Message[] = [];
  if (pending) {
    for (const [, entries] of pending) {
      for (const [id, fields] of entries) {
        if (!fields || fields.length === 0) continue;
        messages.push(fieldsToMessage(id, fields));
      }
    }
  }
  return messages;
}

// Explicitly acknowledge messages for a consumer.
export async function ackMessages(agentId: string, consumer: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const stream = AGENT_STREAM_PREFIX + agentId;
  const group = `${agentId}:${consumer}`;
  try {
    return await redis.xack(stream, group, ...ids);
  } catch (e: any) {
    // NOGROUP or WRONGTYPE: group/stream doesn't exist — nothing to ack
    if (e.message?.includes("NOGROUP") || e.message?.includes("WRONGTYPE")) return 0;
    throw e;
  }
}

export async function readHistory(target: string, count = 20): Promise<Message[]> {
  return pgReadHistory(target, count);
}

// Replay messages from agent stream after sinceId (exclusive) — used by SSE on reconnect.
// Uses XREVRANGE to return only the most recent `count` messages, and clamps
// stale sinceId (older than 24h) to prevent full-history replay from ancient Last-Event-ID.
const MAX_REPLAY_AGE_MS = 24 * 3600 * 1000;
export async function replayStream(agentId: string, sinceId: string, count = 50): Promise<Message[]> {
  const stream = AGENT_STREAM_PREFIX + agentId;
  // Clamp stale sinceId: if older than 24h, use a synthetic ID from 24h ago
  const nowMs = Date.now();
  try {
    const sinceMs = parseInt(sinceId.split("-")[0]);
    if (!isNaN(sinceMs) && nowMs - sinceMs > MAX_REPLAY_AGE_MS) {
      sinceId = `${nowMs - MAX_REPLAY_AGE_MS}-0`;
    }
  } catch { /* keep sinceId as-is */ }
  // XREVRANGE + (sinceId: newest first, exclusive lower bound, limited to count
  const entries = await redis.xrevrange(stream, "+", `(${sinceId}`, "COUNT", count) as [string, string[]][];
  // Reverse to chronological order
  entries.reverse();
  return entries.map(([id, fields]) => fieldsToMessage(id, fields));
}

export async function listChannels(): Promise<string[]> {
  return pgListChannels();
}

export function createSubscriber(agentId: string, onMessage: (msg: Message) => void): { close: () => void } {
  const sub = new Redis({ host: "127.0.0.1", port: 6379, maxRetriesPerRequest: 3 });
  sub.on("error", () => {}); // swallow errors, subscriber is disposable
  const channel = NOTIFY_PREFIX + agentId;
  sub.subscribe(channel).catch(silentCatch("redis subscribe"));
  sub.on("message", (_ch: string, data: string) => {
    try {
      const obj = JSON.parse(data);
      let attachments: Attachment[] | undefined;
      if (obj.attachments) {
        try { attachments = typeof obj.attachments === 'string' ? JSON.parse(obj.attachments) : obj.attachments; } catch {}
      }
      const msg: Message = {
        id: obj._sid,  // stream ID for SSE Last-Event-ID tracking
        from: obj.from,
        to: obj.to,
        type: obj.type || "message",
        text: obj.text,
        channel: obj.channel,
        replyTo: obj.replyTo,
        timestamp: obj.timestamp,
        attachments,
      };
      onMessage(msg);
    } catch {}
  });
  return {
    close: () => {
      try { sub.unsubscribe(channel).catch(silentCatch("redis unsubscribe")); } catch {}
      try { sub.disconnect(); } catch {}
    },
  };
}

export async function publishEvent(event: KonohaEvent): Promise<string> {
  const entry: Record<string, string> = {
    type: event.type,
    source: event.source,
    payload: JSON.stringify(event.payload),
    timestamp: event.timestamp,
    village_id: event.village_id,
  };

  // Write to global events stream
  const id = (await redis.xadd(EVENTS_STREAM, "*", ...Object.entries(entry).flat())) ?? "";

  // Route to subscribed agents (use cached registry, batch via pipeline)
  const all = await listAgents();
  const subscribers = all.filter(a => a.eventSubscriptions?.includes(event.type));
  if (subscribers.length > 0) {
    for (const agent of subscribers) {
      const msgEntry: Record<string, string> = {
        from: event.source,
        to: agent.id,
        type: "event",
        text: JSON.stringify(event),
        timestamp: event.timestamp,
      };
      const sid = await redis.xadd(AGENT_STREAM_PREFIX + agent.id, "*", ...Object.entries(msgEntry).flat());
      await redis.publish(NOTIFY_PREFIX + agent.id, JSON.stringify({ ...msgEntry, _sid: sid }));
      await pgStoreMessage({
        id: sid ?? undefined,
        from: event.source,
        to: agent.id,
        type: "event",
        text: JSON.stringify(event),
        timestamp: event.timestamp,
        village_id: event.village_id,
      });
    }
  }

  return id;
}

function fieldsToMessage(id: string, fields: string[]): Message {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  let attachments: Attachment[] | undefined;
  if (obj.attachments) {
    try { attachments = JSON.parse(obj.attachments); } catch {}
  }
  return {
    id,
    from: obj.from,
    to: obj.to,
    type: (obj.type as Message["type"]) || "message",
    text: obj.text,
    channel: obj.channel,
    replyTo: obj.replyTo,
    timestamp: obj.timestamp,
    attachments,
    village_id: obj.village_id || DEFAULT_VILLAGE,
  };
}
