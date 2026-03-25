import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { streamSSE } from "hono/streaming";
import { mkdirSync, writeFileSync, existsSync, statSync } from "fs";
import { join, extname } from "path";
import {
  registerAgent,
  unregisterAgent,
  heartbeat,
  listAgents,
  sendMessage,
  readMessages,
  readHistory,
  listChannels,
  createSubscriber,
  type Attachment,
} from "./redis";

const ATTACHMENTS_DIR = "/opt/shared/attachments";
mkdirSync(ATTACHMENTS_DIR, { recursive: true });

const API_TOKEN = process.env.KONOHA_TOKEN || "konoha-dev-token";
const PORT = parseInt(process.env.KONOHA_PORT || "3100");

const app = new Hono();

// auth
app.use("/agents/*", bearerAuth({ token: API_TOKEN }));
app.use("/messages/*", bearerAuth({ token: API_TOKEN }));
app.use("/channels/*", bearerAuth({ token: API_TOKEN }));
app.use("/attachments/*", bearerAuth({ token: API_TOKEN }));

// health
app.get("/health", (c) => c.json({ status: "ok", ts: new Date().toISOString() }));

// --- Agents ---

app.post("/agents/register", async (c) => {
  const body = await c.req.json();
  const { id, name, capabilities = [], roles = [] } = body;
  if (!id || !name) return c.json({ error: "id and name required" }, 400);
  const agent = await registerAgent({ id, name, capabilities, roles });
  return c.json(agent, 201);
});

app.delete("/agents/:id", async (c) => {
  const id = c.req.param("id");
  const hard = c.req.query("hard") === "true";
  await unregisterAgent(id, hard);
  return c.json({ ok: true });
});

app.post("/agents/:id/heartbeat", async (c) => {
  const id = c.req.param("id");
  await heartbeat(id);
  return c.json({ ok: true });
});

app.get("/agents", async (c) => {
  const onlineOnly = c.req.query("online") === "true";
  const agents = await listAgents(onlineOnly);
  return c.json(agents);
});

// --- Messages ---

app.post("/messages", async (c) => {
  const body = await c.req.json();
  const { from, to, type = "message", text, channel, replyTo, attachments } = body;
  if (!from || !to || !text) return c.json({ error: "from, to, text required" }, 400);
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
  const id = await sendMessage({ from, to, type, text, channel, replyTo, attachments: validAttachments.length > 0 ? validAttachments : undefined });
  return c.json({ id });
});

// --- File Upload ---

app.post("/attachments", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const from = formData.get("from") as string | null;
  if (!file || !from) return c.json({ error: "file and from required" }, 400);

  const ts = Date.now();
  const ext = extname(file.name) || "";
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
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

app.get("/messages/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  const count = parseInt(c.req.query("count") || "10");
  const messages = await readMessages(agentId, count);
  return c.json(messages);
});

app.get("/messages/:agentId/history", async (c) => {
  const agentId = c.req.param("agentId");
  const count = parseInt(c.req.query("count") || "20");
  const messages = await readHistory(agentId, count);
  return c.json(messages);
});

// --- SSE Stream ---

app.get("/messages/:agentId/stream", async (c) => {
  const agentId = c.req.param("agentId");
  return streamSSE(c, async (stream) => {
    const sub = createSubscriber(agentId, (msg) => {
      try {
        stream.writeSSE({ event: "message", data: JSON.stringify(msg) });
      } catch { sub.close(); }
    });

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

// --- Channels ---

app.get("/channels", async (c) => {
  const channels = await listChannels();
  return c.json(channels);
});

app.get("/channels/:name/history", async (c) => {
  const name = c.req.param("name");
  const count = parseInt(c.req.query("count") || "20");
  const messages = await readHistory(name, count);
  return c.json(messages);
});

console.log(`Konoha bus listening on port ${PORT}`);
export default {
  port: PORT,
  fetch: app.fetch,
};
