import { Hono } from "hono";
import { randomUUID } from "crypto";
import { requireAuth } from "../middleware/auth";
import { redis } from "../redis";
import Anthropic from "@anthropic-ai/sdk";

const _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/** Strip markdown code fences that LLMs sometimes wrap JSON in */
function stripMarkdownFences(raw: string): string {
  const m = raw.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  return m ? m[1].trim() : raw;
}

// --- Tsunade Chat API ---

const TSUNADE_CHAT_PREFIX = "tsunade:chat:";
const CHAT_MAX_HISTORY = 20;

const TSUNADE_SYSTEM = `Ты — Цунаде, AI-ассистент редактора бизнес-процессов в нотации eEPC (Konoha Workflow Engine).
Ты помогаешь бизнес-архитектору работать со схемами процессов.

Типы элементов: event (начало/конец), function (задача/шаг), gateway (AND/OR/XOR развилка), role (исполнитель), document (документ), information_system (информационная система).
Связи flow: [[from_id, to_id], ...].
Позиции: {"element_id": {"x": N, "y": N}}.

Операции, которые ты можешь выполнять:
- Изменить названия элементов
- Выровнять расположение (вертикально сверху-вниз, горизонтально, по центру)
- Равномерно распределить элементы
- Добавить новый элемент (укажи тип, label, позицию)
- Удалить элемент

Когда нужно изменить схему, отвечай строго JSON:
{
  "reply": "Что ты сделал или ответ на вопрос",
  "schema_patch": {
    "update_elements": [{"id": "...", "label": "...", ...other fields}],
    "update_positions": {"id": {"x": N, "y": N}, ...},
    "add_elements": [{"type": "function", "label": "...", "x": N, "y": N}],
    "remove_elements": ["id1", "id2"]
  }
}

Если схему менять не нужно, отвечай JSON:
{"reply": "Твой ответ"}

ВАЖНО: отвечай ТОЛЬКО валидным JSON. Без markdown-оберток.`;

async function handleTsunadeChatRequest(c: any, histKey: string, chatId: string, message: string, schema?: unknown) {
  const rawHistory = await redis.lrange(histKey, 0, -1).catch(() => [] as string[]);
  const history: { role: "user" | "assistant"; content: string }[] = rawHistory.map(r => {
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);

  const schemaContext = schema
    ? `\nТекущая схема процесса:\n${JSON.stringify(schema, null, 2)}`
    : "";

  const userMsg = message + schemaContext;
  const messages: { role: "user" | "assistant"; content: string }[] = [
    ...history,
    { role: "user", content: userMsg },
  ];

  const response = await _anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: TSUNADE_SYSTEM,
    messages,
  });

  const rawReply = (response.content[0] as any).text.trim();
  let reply = rawReply;
  let schema_patch: unknown = undefined;
  try {
    const parsed = JSON.parse(stripMarkdownFences(rawReply));
    reply = (typeof parsed.reply === "string" ? parsed.reply : null) || parsed.text || parsed.message || rawReply;
    if (parsed.schema_patch) schema_patch = parsed.schema_patch;
  } catch { /* not JSON, use raw text */ }

  await redis.rpush(histKey, JSON.stringify({ role: "user", content: message }));
  await redis.rpush(histKey, JSON.stringify({ role: "assistant", content: rawReply }));
  await redis.ltrim(histKey, -CHAT_MAX_HISTORY * 2, -1);
  await redis.expire(histKey, 7 * 24 * 3600); // 7 days TTL

  return { reply, chat_id: chatId, schema_patch: schema_patch ?? null };
}

const router = new Hono();

router.use("/tsunade/chat", requireAuth);
router.post("/tsunade/chat", async (c) => {
  const body = await c.req.json<{ message: string; schema?: unknown; chat_id?: string }>().catch(() => null);
  if (!body?.message?.trim()) return c.json({ error: "message required" }, 400);
  const chatId = body.chat_id || randomUUID();
  const histKey = TSUNADE_CHAT_PREFIX + chatId;
  try {
    const result = await handleTsunadeChatRequest(c, histKey, chatId, body.message, body.schema);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

router.delete("/tsunade/chat/:chat_id", requireAuth, async (c) => {
  const chatId = c.req.param("chat_id");
  await redis.del(TSUNADE_CHAT_PREFIX + chatId).catch(() => {});
  return c.json({ ok: true });
});

// Alias: /ai/process-chat → same Tsunade logic
router.use("/ai/process-chat", requireAuth);
router.post("/ai/process-chat", async (c) => {
  const body = await c.req.json<{ message: string; schema?: unknown; chat_id?: string }>().catch(() => null);
  if (!body?.message?.trim()) return c.json({ error: "message required" }, 400);
  const chatId = body.chat_id || randomUUID();
  const histKey = TSUNADE_CHAT_PREFIX + chatId;
  try {
    const result = await handleTsunadeChatRequest(c, histKey, chatId, body.message, body.schema);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

router.delete("/ai/process-chat/:chat_id", requireAuth, async (c) => {
  const chatId = c.req.param("chat_id");
  await redis.del(TSUNADE_CHAT_PREFIX + chatId).catch(() => {});
  return c.json({ ok: true });
});

// --- Kiba Admin Chat API ---

const KIBA_CHAT_PREFIX = "kiba:chat:";
const KIBA_CHAT_MAX_HISTORY = 16;

const KIBA_SYSTEM = `Ты — Киба, AI-ассистент администратора в системе Konoha.
Ты помогаешь управлять агентами, ролями и людьми через естественный язык.

Ты получаешь контекст текущей страницы (agents/roles/people) и список объектов.

Отвечай ТОЛЬКО валидным JSON (без markdown-оберток):
{
  "reply": "Текст ответа на русском",
  "actions": [
    { "label": "Текст кнопки", "type": "start_agent|stop_agent|restart_agent|delete_agent|create_role|delete_role", "args": {...} }
  ]
}

Если действий нет — массив actions пустой или отсутствует.

Поддерживаемые типы действий:
- start_agent: args: { id }
- stop_agent: args: { id }
- restart_agent: args: { id }
- delete_agent: args: { id } — только управляемые агенты
- create_role: args: { role_id, name, description?, strategy? }
- delete_role: args: { role_id }

Правила:
- Никогда не предлагай удалить системных агентов (naruto, sasuke)
- При запросе "остановить все" исключи naruto и sasuke
- Отвечай кратко и по делу
- Если не знаешь ID объекта — уточни у пользователя`;

router.use("/ai/admin-chat", requireAuth);
router.post("/ai/admin-chat", async (c) => {
  const body = await c.req.json<{ message: string; context?: { page: string; data: unknown[] }; chat_id?: string }>().catch(() => null);
  if (!body?.message?.trim()) return c.json({ error: "message required" }, 400);

  const chatId = body.chat_id || randomUUID();
  const histKey = KIBA_CHAT_PREFIX + chatId;

  const rawHistory = await redis.lrange(histKey, 0, -1).catch(() => [] as string[]);
  const history: { role: "user" | "assistant"; content: string }[] = rawHistory.map(r => {
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);

  const contextBlock = body.context
    ? `\nКонтекст страницы "${body.context.page}":\n${JSON.stringify(body.context.data, null, 2)}`
    : "";

  const userMsg = body.message + contextBlock;
  const messages: { role: "user" | "assistant"; content: string }[] = [
    ...history,
    { role: "user", content: userMsg },
  ];

  try {
    const response = await _anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: KIBA_SYSTEM,
      messages,
    });

    const rawReply = (response.content[0] as any).text.trim();
    let reply = rawReply;
    let actions: unknown[] = [];
    try {
      const parsed = JSON.parse(stripMarkdownFences(rawReply));
      reply = (typeof parsed.reply === "string" ? parsed.reply : null) || parsed.text || parsed.message || rawReply;
      if (Array.isArray(parsed.actions)) actions = parsed.actions;
    } catch { /* not JSON, use raw text */ }

    await redis.rpush(histKey, JSON.stringify({ role: "user", content: body.message }));
    await redis.rpush(histKey, JSON.stringify({ role: "assistant", content: rawReply }));
    await redis.ltrim(histKey, -KIBA_CHAT_MAX_HISTORY * 2, -1);
    await redis.expire(histKey, 3 * 24 * 3600);

    return c.json({ reply, chat_id: chatId, actions });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

router.delete("/ai/admin-chat/:chat_id", requireAuth, async (c) => {
  const chatId = c.req.param("chat_id");
  await redis.del(KIBA_CHAT_PREFIX + chatId).catch(() => {});
  return c.json({ ok: true });
});

export default router;
