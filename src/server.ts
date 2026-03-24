import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import {
  registerAgent,
  unregisterAgent,
  heartbeat,
  listAgents,
  sendMessage,
  readMessages,
  readHistory,
  listChannels,
} from "./redis";

const API_TOKEN = process.env.KONOHA_TOKEN || "konoha-dev-token";
const PORT = parseInt(process.env.KONOHA_PORT || "3100");

const app = new Hono();

// auth
app.use("/agents/*", bearerAuth({ token: API_TOKEN }));
app.use("/messages/*", bearerAuth({ token: API_TOKEN }));
app.use("/channels/*", bearerAuth({ token: API_TOKEN }));

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
  await unregisterAgent(id);
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
  const { from, to, type = "message", text, channel, replyTo } = body;
  if (!from || !to || !text) return c.json({ error: "from, to, text required" }, 400);
  const id = await sendMessage({ from, to, type, text, channel, replyTo });
  return c.json({ id });
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
