import Redis from "ioredis";

const REGISTRY_KEY = "konoha:registry";
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

export async function registerAgent(agent: Omit<Agent, "status" | "lastHeartbeat">): Promise<Agent> {
  const full: Agent = {
    ...agent,
    status: "online",
    lastHeartbeat: Date.now(),
  };
  await redis.hset(REGISTRY_KEY, agent.id, JSON.stringify(full));

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

  return full;
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

export async function readMessages(agentId: string, count = 10): Promise<Message[]> {
  const stream = AGENT_STREAM_PREFIX + agentId;

  // read unacknowledged + new
  const pending = await redis.xreadgroup(
    "GROUP", agentId, agentId, "COUNT", count, "STREAMS", stream, "0"
  ) as [string, [string, string[]][]][] | null;

  const messages: Message[] = [];

  if (pending) {
    for (const [, entries] of pending) {
      for (const [id, fields] of entries) {
        if (!fields || fields.length === 0) continue;
        const msg = fieldsToMessage(id, fields);
        messages.push(msg);
        await redis.xack(stream, agentId, id);
      }
    }
  }

  // read new messages
  const fresh = await redis.xreadgroup(
    "GROUP", agentId, agentId, "COUNT", count, "STREAMS", stream, ">"
  ) as [string, [string, string[]][]][] | null;

  if (fresh) {
    for (const [, entries] of fresh) {
      for (const [id, fields] of entries) {
        const msg = fieldsToMessage(id, fields);
        messages.push(msg);
        await redis.xack(stream, agentId, id);
      }
    }
  }

  return messages;
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
