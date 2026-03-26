import Redis from "ioredis";
import { randomUUID } from "crypto";

const REGISTRY_KEY = "konoha:registry";
const TOKENS_KEY = "konoha:tokens"; // token → agentId
const INVITES_KEY = "konoha:invites"; // invite token → expiry (stored as Redis key with TTL)
const INVITE_TTL = 3600; // seconds (1 hour)
const BUS_STREAM = "konoha:bus";
const AGENT_STREAM_PREFIX = "konoha:agent:";
const CHANNEL_STREAM_PREFIX = "konoha:channel:";
const HEARTBEAT_TTL = 600; // seconds (10 minutes)

export interface Agent {
  id: string;
  name: string;
  capabilities: string[];
  roles: string[];
  status: "online" | "offline";
  lastHeartbeat: number;
  token?: string; // returned on registration, not stored in registry
}

export interface Attachment {
  name: string;        // original filename
  path: string;        // absolute path in shared storage
  mime?: string;        // MIME type
  size?: number;        // bytes
}

export interface Message {
  id?: string;
  from: string;
  to: string; // agent id, "all", or "role:<role>"
  channel?: string;
  type: "message" | "task" | "result" | "status" | "event";
  text: string;
  replyTo?: string;
  timestamp?: string;
  attachments?: Attachment[];
}

function createRedis(): Redis {
  const r = new Redis({ host: "127.0.0.1", port: 6379, maxRetriesPerRequest: 3, lazyConnect: false });
  r.on("error", (err) => {
    console.error("[Redis error]", err.message);
  });
  return r;
}

export const redis = createRedis();
export const redisSub = createRedis(); // separate connection for blocking reads

export async function registerAgent(agent: Omit<Agent, "status" | "lastHeartbeat" | "token">): Promise<Agent> {
  const stored: Agent = {
    ...agent,
    status: "online",
    lastHeartbeat: Date.now(),
  };
  await redis.hset(REGISTRY_KEY, agent.id, JSON.stringify(stored));

  // generate and store per-agent token (delete old token for this agent first)
  const oldTokenData = await redis.hgetall(TOKENS_KEY);
  for (const [tok, aid] of Object.entries(oldTokenData)) {
    if (aid === agent.id) await redis.hdel(TOKENS_KEY, tok);
  }
  const agentToken = randomUUID();
  await redis.hset(TOKENS_KEY, agentToken, agent.id);

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
  return redis.hget(TOKENS_KEY, token);
}

export async function createInvite(): Promise<{ token: string; expiresAt: string }> {
  const token = "inv-" + randomUUID();
  await redis.set(`${INVITES_KEY}:${token}`, "1", "EX", INVITE_TTL);
  const expiresAt = new Date(Date.now() + INVITE_TTL * 1000).toISOString();
  return { token, expiresAt };
}

export async function consumeInvite(token: string): Promise<boolean> {
  const key = `${INVITES_KEY}:${token}`;
  const deleted = await redis.del(key);
  return deleted === 1;
}

export async function unregisterAgent(id: string, hard = false): Promise<void> {
  if (hard) {
    await redis.hdel(REGISTRY_KEY, id);
  } else {
    const data = await redis.hget(REGISTRY_KEY, id);
    if (data) {
      const agent: Agent = JSON.parse(data);
      agent.status = "offline";
      await redis.hset(REGISTRY_KEY, id, JSON.stringify(agent));
    }
  }
}

export async function heartbeat(id: string): Promise<void> {
  const data = await redis.hget(REGISTRY_KEY, id);
  if (!data) return;
  const agent: Agent = JSON.parse(data);
  agent.status = "online";
  agent.lastHeartbeat = Date.now();
  await redis.hset(REGISTRY_KEY, id, JSON.stringify(agent));
}

export async function listAgents(onlineOnly = false): Promise<Agent[]> {
  const all = await redis.hgetall(REGISTRY_KEY);
  const now = Date.now();
  const agents: Agent[] = [];

  for (const [, val] of Object.entries(all)) {
    const agent: Agent = JSON.parse(val);
    // mark stale agents as offline
    if (now - agent.lastHeartbeat > HEARTBEAT_TTL * 1000) {
      agent.status = "offline";
    }
    if (onlineOnly && agent.status === "offline") continue;
    agents.push(agent);
  }
  return agents;
}

const NOTIFY_PREFIX = "konoha:notify:";

export async function sendMessage(msg: Message): Promise<string> {
  const entry: Record<string, string> = {
    from: msg.from,
    to: msg.to,
    type: msg.type,
    text: msg.text,
    timestamp: msg.timestamp || new Date().toISOString(),
  };
  if (msg.channel) entry.channel = msg.channel;
  if (msg.replyTo) entry.replyTo = msg.replyTo;
  if (msg.attachments && msg.attachments.length > 0) {
    entry.attachments = JSON.stringify(msg.attachments);
  }

  // publish to bus stream (for broadcast/logging)
  const id = await redis.xadd(BUS_STREAM, "*", ...Object.entries(entry).flat());

  // route to recipients
  if (msg.to === "all") {
    // broadcast: write to each online agent's stream (except sender)
    const agents = await listAgents(true);
    for (const agent of agents) {
      if (agent.id !== msg.from) {
        await redis.xadd(AGENT_STREAM_PREFIX + agent.id, "*", ...Object.entries(entry).flat());
        await redis.publish(NOTIFY_PREFIX + agent.id, JSON.stringify(entry));
      }
    }
  } else if (msg.to.startsWith("role:")) {
    // role-based routing
    const role = msg.to.slice(5);
    const agents = await listAgents(true);
    for (const agent of agents) {
      if (agent.roles.includes(role) && agent.id !== msg.from) {
        await redis.xadd(AGENT_STREAM_PREFIX + agent.id, "*", ...Object.entries(entry).flat());
        await redis.publish(NOTIFY_PREFIX + agent.id, JSON.stringify(entry));
      }
    }
  } else {
    // direct message
    await redis.xadd(AGENT_STREAM_PREFIX + msg.to, "*", ...Object.entries(entry).flat());
    await redis.publish(NOTIFY_PREFIX + msg.to, JSON.stringify(entry));
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
  return redis.xack(stream, group, ...ids);
}

export async function readHistory(target: string, count = 20): Promise<Message[]> {
  // target can be agent id or channel name
  let stream = AGENT_STREAM_PREFIX + target;
  const exists = await redis.exists(stream);
  if (!exists) {
    stream = CHANNEL_STREAM_PREFIX + target;
  }

  const entries = await redis.xrevrange(stream, "+", "-", "COUNT", count);
  return entries.map(([id, fields]) => fieldsToMessage(id, fields)).reverse();
}

export async function listChannels(): Promise<string[]> {
  const keys = await redis.keys(CHANNEL_STREAM_PREFIX + "*");
  return keys.map(k => k.replace(CHANNEL_STREAM_PREFIX, ""));
}

export function createSubscriber(agentId: string, onMessage: (msg: Message) => void): { close: () => void } {
  const sub = new Redis({ host: "127.0.0.1", port: 6379, maxRetriesPerRequest: 3 });
  sub.on("error", () => {}); // swallow errors, subscriber is disposable
  const channel = NOTIFY_PREFIX + agentId;
  sub.subscribe(channel).catch(() => {});
  sub.on("message", (_ch: string, data: string) => {
    try {
      const obj = JSON.parse(data);
      let attachments: Attachment[] | undefined;
      if (obj.attachments) {
        try { attachments = typeof obj.attachments === 'string' ? JSON.parse(obj.attachments) : obj.attachments; } catch {}
      }
      const msg: Message = {
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
      sub.unsubscribe(channel);
      sub.disconnect();
    },
  };
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
  };
}
