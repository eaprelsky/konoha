/**
 * Konoha redis.ts unit tests — bun test
 *
 * Tests the Redis layer functions directly without going through HTTP.
 * Uses test-specific key prefixes and cleans up after itself.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Redis from "ioredis";

// Import functions under test
import {
  registerAgent,
  unregisterAgent,
  heartbeat,
  listAgents,
  sendMessage,
  readMessages,
  readMessagesPending,
  ackMessages,
  readHistory,
  listChannels,
  getAgentIdByToken,
  createInvite,
  consumeInvite,
} from "../src/redis";

const redis = new Redis({ host: "127.0.0.1", port: 6379 });
const RUN = `r${Date.now()}`;
function id(name: string) { return `rtest-${name}-${RUN}`; }

// ── cleanup ───────────────────────────────────────────────────────────────────

async function cleanupTestData() {
  const regKeys = await redis.hkeys("konoha:registry");
  for (const k of regKeys) {
    if (k.startsWith("rtest-")) await redis.hdel("konoha:registry", k);
  }
  const tokenMap = await redis.hgetall("konoha:tokens");
  for (const [tok, agentId] of Object.entries(tokenMap ?? {})) {
    if (agentId.startsWith("rtest-")) await redis.hdel("konoha:tokens", tok);
  }
  const streamKeys = await redis.keys("konoha:agent:rtest-*");
  if (streamKeys.length) await redis.del(...streamKeys);
}

beforeAll(cleanupTestData);
afterAll(async () => {
  await cleanupTestData();
  redis.disconnect();
});

// ── registerAgent ─────────────────────────────────────────────────────────────

describe("registerAgent", () => {
  test("returns agent with status=online and a token", async () => {
    const agentId = id("reg1");
    const agent = await registerAgent({ id: agentId, name: "Redis Reg1", capabilities: ["cap1"], roles: ["r1"] });
    expect(agent.id).toBe(agentId);
    expect(agent.status).toBe("online");
    expect(typeof agent.token).toBe("string");
    expect(agent.token!.length).toBeGreaterThan(8);
    expect(agent.capabilities).toContain("cap1");
    expect(agent.roles).toContain("r1");
  });

  test("stores agent in registry", async () => {
    const agentId = id("reg2");
    await registerAgent({ id: agentId, name: "Redis Reg2", capabilities: [], roles: [] });
    const raw = await redis.hget("konoha:registry", agentId);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!);
    expect(stored.id).toBe(agentId);
    expect(stored.status).toBe("online");
  });

  test("token maps to agent id in tokens hash", async () => {
    const agentId = id("reg3");
    const agent = await registerAgent({ id: agentId, name: "Redis Reg3", capabilities: [], roles: [] });
    const resolvedId = await getAgentIdByToken(agent.token!);
    expect(resolvedId).toBe(agentId);
  });

  test("re-registration replaces old token", async () => {
    const agentId = id("rereg");
    const first = await registerAgent({ id: agentId, name: "Rereg", capabilities: [], roles: [] });
    const second = await registerAgent({ id: agentId, name: "Rereg v2", capabilities: [], roles: [] });
    expect(first.token).not.toBe(second.token);
    // Old token should no longer resolve
    const resolved = await getAgentIdByToken(first.token!);
    expect(resolved).toBeNull();
  });

  test("creates Redis consumer group for agent stream", async () => {
    const agentId = id("cg");
    await registerAgent({ id: agentId, name: "CG Agent", capabilities: [], roles: [] });
    // If the group exists, xgroup create will throw BUSYGROUP — otherwise succeeds
    let groupExists = false;
    try {
      await redis.xgroup("CREATE", `konoha:agent:${agentId}`, agentId, "0", "MKSTREAM");
    } catch (e: any) {
      if (e.message?.includes("BUSYGROUP")) groupExists = true;
    }
    expect(groupExists).toBe(true);
  });
});

// ── getAgentIdByToken ─────────────────────────────────────────────────────────

describe("getAgentIdByToken", () => {
  test("returns null for unknown token", async () => {
    const result = await getAgentIdByToken("fake-token-xyz");
    expect(result).toBeNull();
  });

  test("returns agentId for valid token", async () => {
    const agentId = id("tok");
    const agent = await registerAgent({ id: agentId, name: "Tok Agent", capabilities: [], roles: [] });
    const result = await getAgentIdByToken(agent.token!);
    expect(result).toBe(agentId);
  });
});

// ── createInvite / consumeInvite ──────────────────────────────────────────────

describe("createInvite / consumeInvite", () => {
  test("creates invite token with expiry", async () => {
    const invite = await createInvite();
    expect(invite.token.startsWith("inv-")).toBe(true);
    expect(typeof invite.expiresAt).toBe("string");
    const ttl = await redis.ttl(`konoha:invites:${invite.token}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  test("consumeInvite returns true and deletes key", async () => {
    const invite = await createInvite();
    const result = await consumeInvite(invite.token);
    expect(result).toBe(true);
    const exists = await redis.exists(`konoha:invites:${invite.token}`);
    expect(exists).toBe(0);
  });

  test("consumeInvite returns false for non-existent token", async () => {
    const result = await consumeInvite("inv-fake-token-xyz");
    expect(result).toBe(false);
  });

  test("invite is one-time: second consume returns false", async () => {
    const invite = await createInvite();
    await consumeInvite(invite.token);
    const second = await consumeInvite(invite.token);
    expect(second).toBe(false);
  });
});

// ── unregisterAgent ───────────────────────────────────────────────────────────

describe("unregisterAgent", () => {
  test("soft unregister marks status=offline", async () => {
    const agentId = id("unreg-soft");
    await registerAgent({ id: agentId, name: "Unreg Soft", capabilities: [], roles: [] });
    await unregisterAgent(agentId, false);
    const raw = await redis.hget("konoha:registry", agentId);
    const stored = JSON.parse(raw!);
    expect(stored.status).toBe("offline");
  });

  test("hard unregister removes agent from registry", async () => {
    const agentId = id("unreg-hard");
    await registerAgent({ id: agentId, name: "Unreg Hard", capabilities: [], roles: [] });
    await unregisterAgent(agentId, true);
    const raw = await redis.hget("konoha:registry", agentId);
    expect(raw).toBeNull();
  });
});

// ── heartbeat ─────────────────────────────────────────────────────────────────

describe("heartbeat", () => {
  test("updates lastHeartbeat and sets status=online", async () => {
    const agentId = id("hb");
    await registerAgent({ id: agentId, name: "HB Agent", capabilities: [], roles: [] });
    // Mark offline first
    await unregisterAgent(agentId, false);

    const before = Date.now();
    await heartbeat(agentId);
    const after = Date.now();

    const raw = await redis.hget("konoha:registry", agentId);
    const stored = JSON.parse(raw!);
    expect(stored.status).toBe("online");
    expect(stored.lastHeartbeat).toBeGreaterThanOrEqual(before);
    expect(stored.lastHeartbeat).toBeLessThanOrEqual(after + 100);
  });

  test("heartbeat on unknown agent is a no-op (no throw)", async () => {
    await expect(heartbeat(id("ghost-hb"))).resolves.toBeUndefined();
  });
});

// ── listAgents ────────────────────────────────────────────────────────────────

describe("listAgents", () => {
  test("includes registered agents", async () => {
    const agentId = id("list");
    await registerAgent({ id: agentId, name: "List Agent", capabilities: ["c1"], roles: ["r1"] });
    const agents = await listAgents();
    const found = agents.find(a => a.id === agentId);
    expect(found).toBeDefined();
    expect(found!.name).toBe("List Agent");
  });

  test("marks stale agents as offline", async () => {
    const agentId = id("stale");
    await registerAgent({ id: agentId, name: "Stale Agent", capabilities: [], roles: [] });
    // Manually set lastHeartbeat to old timestamp
    const raw = await redis.hget("konoha:registry", agentId);
    const stored = JSON.parse(raw!);
    stored.lastHeartbeat = Date.now() - 700_000; // > 600s ago
    stored.status = "online";
    await redis.hset("konoha:registry", agentId, JSON.stringify(stored));

    const agents = await listAgents();
    const found = agents.find(a => a.id === agentId);
    expect(found!.status).toBe("offline");
  });

  test("onlineOnly=true excludes offline agents", async () => {
    const agentId = id("offline-filter");
    await registerAgent({ id: agentId, name: "Offline Filter", capabilities: [], roles: [] });
    await unregisterAgent(agentId, false);

    const online = await listAgents(true);
    const found = online.find(a => a.id === agentId);
    expect(found).toBeUndefined();
  });
});

// ── sendMessage / readMessages ────────────────────────────────────────────────

describe("sendMessage / readMessages", () => {
  test("sends and reads a direct message", async () => {
    const toId = id("recv");
    await registerAgent({ id: toId, name: "Recv", capabilities: [], roles: [] });

    const msgId = await sendMessage({ from: "tester", to: toId, type: "message", text: "hello direct" });
    expect(typeof msgId).toBe("string");

    const msgs = await readMessages(toId);
    const found = msgs.find(m => m.text === "hello direct");
    expect(found).toBeDefined();
    expect(found!.from).toBe("tester");
    expect(found!.to).toBe(toId);
  });

  test("messages are isolated per agent inbox", async () => {
    const agentA = id("iso-a");
    const agentB = id("iso-b");
    await registerAgent({ id: agentA, name: "Iso A", capabilities: [], roles: [] });
    await registerAgent({ id: agentB, name: "Iso B", capabilities: [], roles: [] });

    await sendMessage({ from: "tester", to: agentA, type: "message", text: "only for A" });

    const msgsB = await readMessages(agentB);
    const leaked = msgsB.find(m => m.text === "only for A");
    expect(leaked).toBeUndefined();
  });

  test("fan-out: different consumers see same messages", async () => {
    const toId = id("fanout");
    await registerAgent({ id: toId, name: "Fanout", capabilities: [], roles: [] });

    await sendMessage({ from: "src", to: toId, type: "message", text: "fan msg" });

    const msgsC1 = await readMessages(toId, 10, "consumer1");
    const msgsC2 = await readMessages(toId, 10, "consumer2");

    const c1Found = msgsC1.find(m => m.text === "fan msg");
    const c2Found = msgsC2.find(m => m.text === "fan msg");
    expect(c1Found).toBeDefined();
    expect(c2Found).toBeDefined();
  });

  test("broadcast to 'all' reaches all online agents except sender", async () => {
    const sender = id("bc-sender");
    const recv1 = id("bc-recv1");
    const recv2 = id("bc-recv2");
    await registerAgent({ id: sender, name: "BC Sender", capabilities: [], roles: [] });
    await registerAgent({ id: recv1, name: "BC Recv1", capabilities: [], roles: [] });
    await registerAgent({ id: recv2, name: "BC Recv2", capabilities: [], roles: [] });

    await sendMessage({ from: sender, to: "all", type: "event", text: "broadcast!" });

    const m1 = await readMessages(recv1);
    const m2 = await readMessages(recv2);
    const senderMsgs = await readMessages(sender);

    expect(m1.find(m => m.text === "broadcast!")).toBeDefined();
    expect(m2.find(m => m.text === "broadcast!")).toBeDefined();
    // sender should NOT receive its own broadcast
    expect(senderMsgs.find(m => m.text === "broadcast!")).toBeUndefined();
  });

  test("role-based routing delivers to agents with matching role", async () => {
    const roleAgent = id("role-agent");
    const otherAgent = id("role-other");
    await registerAgent({ id: roleAgent, name: "Role Agent", capabilities: [], roles: ["test-dispatch"] });
    await registerAgent({ id: otherAgent, name: "Other Agent", capabilities: [], roles: ["other-role"] });

    await sendMessage({ from: "src", to: "role:test-dispatch", type: "task", text: "role msg" });

    const roleMsgs = await readMessages(roleAgent);
    const otherMsgs = await readMessages(otherAgent);

    expect(roleMsgs.find(m => m.text === "role msg")).toBeDefined();
    expect(otherMsgs.find(m => m.text === "role msg")).toBeUndefined();
  });

  test("empty inbox returns empty array", async () => {
    const msgs = await readMessages(id("empty-inbox"), 5);
    expect(msgs).toEqual([]);
  });
});

// ── readMessagesPending / ackMessages ─────────────────────────────────────────

describe("readMessagesPending / ackMessages", () => {
  test("pending messages survive multiple readMessagesPending calls (no auto-ack)", async () => {
    const agentId = id("pending");
    const consumer = "pendingConsumer";
    await registerAgent({ id: agentId, name: "Pending", capabilities: [], roles: [] });
    await sendMessage({ from: "src", to: agentId, type: "message", text: "pending msg" });

    const stream = `konoha:agent:${agentId}`;
    const group = `${agentId}:${consumer}`;
    // Ensure group and deliver the message to consumer (without acking)
    try { await redis.xgroup("CREATE", stream, group, "0", "MKSTREAM"); } catch {}
    await redis.xreadgroup("GROUP", group, consumer, "COUNT", 10, "STREAMS", stream, ">");

    // readMessagesPending reads "0" (already delivered, not acked)
    const pending1 = await readMessagesPending(agentId, consumer);
    expect(pending1.find(m => m.text === "pending msg")).toBeDefined();

    // Second call — still pending (no ack happened)
    const pending2 = await readMessagesPending(agentId, consumer);
    expect(pending2.find(m => m.text === "pending msg")).toBeDefined();
  });

  test("ackMessages removes message from pending", async () => {
    const agentId = id("ack");
    const consumer = "ackConsumer";
    await registerAgent({ id: agentId, name: "Ack Agent", capabilities: [], roles: [] });
    await sendMessage({ from: "src", to: agentId, type: "message", text: "ack msg" });

    const stream = `konoha:agent:${agentId}`;
    const group = `${agentId}:${consumer}`;
    // Deliver without ack
    try { await redis.xgroup("CREATE", stream, group, "0", "MKSTREAM"); } catch {}
    await redis.xreadgroup("GROUP", group, consumer, "COUNT", 10, "STREAMS", stream, ">");

    const pending = await readMessagesPending(agentId, consumer);
    const msgId = pending.find(m => m.text === "ack msg")?.id;
    expect(msgId).toBeDefined();

    const acked = await ackMessages(agentId, consumer, [msgId!]);
    expect(acked).toBe(1);

    // After ack, message no longer in pending
    const after = await readMessagesPending(agentId, consumer);
    expect(after.find(m => m.text === "ack msg")).toBeUndefined();
  });

  test("readMessages auto-acks: same message not returned on second call", async () => {
    const agentId = id("autoack");
    await registerAgent({ id: agentId, name: "AutoAck", capabilities: [], roles: [] });
    await sendMessage({ from: "src", to: agentId, type: "message", text: "autoack msg" });

    const first = await readMessages(agentId, 10, "autoackConsumer");
    expect(first.find(m => m.text === "autoack msg")).toBeDefined();

    // Second read with same consumer — message already acked, should not reappear
    const second = await readMessages(agentId, 10, "autoackConsumer");
    expect(second.find(m => m.text === "autoack msg")).toBeUndefined();
  });
});

// ── readHistory ───────────────────────────────────────────────────────────────

describe("readHistory", () => {
  test("returns messages in chronological order", async () => {
    const agentId = id("hist");
    await registerAgent({ id: agentId, name: "Hist", capabilities: [], roles: [] });

    await sendMessage({ from: "src", to: agentId, type: "message", text: "hist1" });
    await sendMessage({ from: "src", to: agentId, type: "message", text: "hist2" });
    await sendMessage({ from: "src", to: agentId, type: "message", text: "hist3" });

    const history = await readHistory(agentId, 10);
    const texts = history.map(m => m.text);
    const i1 = texts.indexOf("hist1");
    const i2 = texts.indexOf("hist2");
    const i3 = texts.indexOf("hist3");
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
  });

  test("count parameter limits results", async () => {
    const agentId = id("hist-count");
    await registerAgent({ id: agentId, name: "Hist Count", capabilities: [], roles: [] });
    for (let i = 0; i < 5; i++) {
      await sendMessage({ from: "src", to: agentId, type: "message", text: `msg${i}` });
    }
    const history = await readHistory(agentId, 3);
    expect(history.length).toBeLessThanOrEqual(3);
  });

  test("returns empty array for unknown agent", async () => {
    const history = await readHistory(id("hist-ghost"));
    expect(history).toEqual([]);
  });
});

// ── listChannels ──────────────────────────────────────────────────────────────

describe("listChannels", () => {
  test("channel appears after message sent to it", async () => {
    const agentId = id("chan-agent");
    const channelName = `test-channel-${RUN}`;
    await registerAgent({ id: agentId, name: "Chan Agent", capabilities: [], roles: [] });

    await sendMessage({ from: "src", to: agentId, type: "message", text: "chan msg", channel: channelName });

    const channels = await listChannels();
    expect(channels).toContain(channelName);
  });
});
