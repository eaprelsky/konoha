import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { streamSSE } from "hono/streaming";
import { writeFileSync, existsSync, statSync } from "fs";
import { join, extname } from "path";

import { requireAuth } from "../middleware/auth";
import {
  sendMessage,
  readMessages,
  readMessagesPending,
  ackMessages,
  readHistory,
  replayStream,
  replayStreamBefore,
  listChannels,
  createSubscriber,
  redis,
  AGENT_STREAM_PREFIX,
  type Attachment,
} from "../redis";
import { createSseMessageDeduper, type SseMessageEvent } from "../sse-dedup";

const ATTACHMENTS_DIR = "/opt/shared/attachments";

const router = new Hono<HonoEnv>();

// All messages and attachments routes require auth (set at mount level in server.ts)

const MAX_MESSAGE_TEXT_LENGTH = 32000; // chars; protects against silent truncation in downstream delivery

router.post("/", async (c) => {
  const body = await c.req.json();
  const { to, type = "message", text, channel, replyTo, attachments, village_id } = body;
  const caller: { isAdmin: boolean; agentId: string | null } = c.get("caller");
  const idempotencyKey = body.idempotency_key ?? body.idempotencyKey;

  // Determine sender: admin can specify from, agent token sets from automatically
  const from: string = caller.isAdmin ? (body.from || "admin") : caller.agentId!;
  if (!from || !to || !text) return c.json({ error: "from, to, text required" }, 400);
  if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
    return c.json({ error: "idempotency_key must be a string" }, 400);
  }
  if (typeof text === "string" && text.length > MAX_MESSAGE_TEXT_LENGTH) {
    return c.json({
      error: `Message text too long: ${text.length} chars (max ${MAX_MESSAGE_TEXT_LENGTH}). Use konoha_send with a shorter message or split into multiple messages.`,
    }, 413);
  }
  // validate attachment paths exist
  const validAttachments: Attachment[] = [];
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (att.path && existsSync(att.path)) {
        const st = statSync(att.path);
        validAttachments.push({
          name: att.name || att.path.split("/").pop() || "file",
          path: att.path,
          mime: att.mime,
          size: att.size || st.size,
        });
      }
    }
  }
  const id = await sendMessage({
    from,
    to,
    type,
    text,
    channel,
    replyTo,
    attachments: validAttachments.length > 0 ? validAttachments : undefined,
    ...(village_id ? { village_id } : {}),
    ...(idempotencyKey?.trim() ? { idempotencyKey: idempotencyKey.trim() } : {}),
  });
  return c.json({ id });
});

router.get("/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  const caller: { isAdmin: boolean; agentId: string | null } = c.get("caller");
  // Non-admin agents can only read their own inbox
  if (!caller.isAdmin && caller.agentId !== agentId) {
    return c.json({ error: "Forbidden: can only read your own inbox" }, 403);
  }
  const count = parseInt(c.req.query("count") || "10");
  // Optional consumer param for fan-out: each consumer sees all messages independently
  const consumer = c.req.query("consumer") || undefined;
  const messages = await readMessages(agentId, count, consumer);
  return c.json(messages);
});

// GET pending messages without auto-ack (requires ?consumer=xxx)
router.get("/:agentId/pending", async (c) => {
  const agentId = c.req.param("agentId");
  const caller: { isAdmin: boolean; agentId: string | null } = c.get("caller");
  if (!caller.isAdmin && caller.agentId !== agentId) {
    return c.json({ error: "Forbidden: can only read your own inbox" }, 403);
  }
  const consumer = c.req.query("consumer");
  if (!consumer) return c.json({ error: "consumer query param required" }, 400);
  const count = parseInt(c.req.query("count") || "10");
  const messages = await readMessagesPending(agentId, consumer, count);
  return c.json(messages);
});

// POST ack: acknowledge specific message IDs for a consumer
router.post("/:agentId/ack", async (c) => {
  const agentId = c.req.param("agentId");
  const caller: { isAdmin: boolean; agentId: string | null } = c.get("caller");
  if (!caller.isAdmin && caller.agentId !== agentId) {
    return c.json({ error: "Forbidden: can only ack your own messages" }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const { consumer, ids } = body as { consumer?: string; ids?: unknown[] };
  if (!consumer || !Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: "consumer and ids[] required" }, 400);
  }
  const stringIds = ids.map(String);
  try {
    const acked = await ackMessages(agentId, consumer, stringIds);
    return c.json({ acked });
  } catch (e: any) {
    return c.json({ error: e.message, acked: 0 }, 500);
  }
});

router.get("/:agentId/history", async (c) => {
  const agentId = c.req.param("agentId");
  const count = parseInt(c.req.query("count") || "20");
  const messages = await readHistory(agentId, count);
  return c.json(messages);
});

// SSE Stream — durable-delivery (Stream replay) + live-tail (pub/sub) contract (refs #794).
// Pre-subscribe buffer closes the gap: messages arriving during replay are held and
// flushed with dedup, guaranteeing no lost messages and no duplicates.
router.get("/:agentId/stream", async (c) => {
  const agentId = c.req.param("agentId");
  let since = c.req.header("Last-Event-ID") || c.req.query("since") || "";
  return streamSSE(c, async (stream) => {
    // Messages arriving during replay are held, then flushed through the same
    // deduper as replay/live writes. The deduper is seeded from the delivered
    // lookbehind window so reconnect replay does not resend logical duplicates
    // that have a new Redis stream/SSE id.
    const buffer: SseMessageEvent[] = [];
    const deduper = createSseMessageDeduper();
    let liveMode = false;

    const sub = createSubscriber(agentId, (msg) => {
      const evt = { id: msg.id, event: "message", data: JSON.stringify(msg) };
      if (!liveMode) { buffer.push(evt); }
      else if (deduper.shouldDeliverEvent(evt)) {
        try { stream.writeSSE(evt); } catch { sub.close(); }
      }
    });

    // Resolve the "since" cursor AFTER the subscriber is live to close
    // the window between cursor fetch and subscriber creation (refs #794).
    // Messages arriving during this window are held in the pre-subscribe
    // buffer and flushed with dedup — no lost messages.
    let resolvedSince = since;
    if (!resolvedSince) {
      try {
        const lastEntries = await redis.xrevrange(AGENT_STREAM_PREFIX + agentId, "+", "-", "COUNT", 1);
        if (lastEntries.length > 0) resolvedSince = lastEntries[0][0];
      } catch { /* fall through */ }
    }

    // Replay messages missed while disconnected
    if (resolvedSince) {
      try {
        try {
          deduper.seed(await replayStreamBefore(agentId, resolvedSince));
        } catch { /* replay still works without the reconnect lookbehind seed */ }
        const missed = await replayStream(agentId, resolvedSince);
        for (const msg of missed) {
          if (stream.aborted) break;
          if (!deduper.shouldDeliverMessage(msg)) continue;
          await stream.writeSSE({ id: msg.id, event: "message", data: JSON.stringify(msg) });
        }
        // Switch to live mode — flush buffered messages not already delivered
        liveMode = true;
        for (const evt of buffer) {
          if (stream.aborted) break;
          if (!deduper.shouldDeliverEvent(evt)) continue;
          await stream.writeSSE(evt);
        }
      } catch { liveMode = true; }
    } else {
      liveMode = true;
      // Flush buffered messages that arrived during subscriber setup
      for (const evt of buffer) {
        if (stream.aborted) break;
        if (!deduper.shouldDeliverEvent(evt)) continue;
        try { stream.writeSSE(evt); } catch { sub.close(); }
      }
    }

    // Ping to confirm stream is live
    try { await stream.writeSSE({ event: "ping", data: "" }); } catch {}

    const keepAlive = setInterval(() => {
      try { stream.writeSSE({ event: "ping", data: "" }); }
      catch { clearInterval(keepAlive); sub.close(); }
    }, 30000);

    stream.onAbort(() => {
      clearInterval(keepAlive);
      sub.close();
    });

    await new Promise(() => {});
  });
});

export default router;

// Attachments router (mounted separately at /attachments)
export const attachmentsRouter = new Hono();

attachmentsRouter.post("/", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const from = formData.get("from") as string | null;
  if (!file || !from) return c.json({ error: "file and from required" }, 400);

  const ts = Date.now();
  const ext = extname(file.name) || "";
  const storedName = `${from}-${ts}${ext ? ext : ""}`;
  const storedPath = join(ATTACHMENTS_DIR, storedName);

  const buf = Buffer.from(await file.arrayBuffer());
  writeFileSync(storedPath, buf);

  const attachment: Attachment = {
    name: file.name,
    path: storedPath,
    mime: file.type || undefined,
    size: buf.length,
  };

  return c.json({ attachment }, 201);
});

// Channels router (mounted separately at /channels)
export const channelsRouter = new Hono();

channelsRouter.get("/", async (c) => {
  const channels = await listChannels();
  return c.json(channels);
});

channelsRouter.get("/:name/history", async (c) => {
  const name = c.req.param("name");
  const count = parseInt(c.req.query("count") || "20");
  const messages = await readHistory(name, count);
  return c.json(messages);
});
