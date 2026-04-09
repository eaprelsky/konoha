import { Hono } from "hono";
import { randomUUID } from "crypto";
import { readFileSync, existsSync } from "fs";
import { requireAuth } from "../middleware/auth";
import { redis } from "../redis";
import Anthropic from "@anthropic-ai/sdk";
import { createWorkflow } from "../workflow-loader";

/** Build content blocks from text + optional attachment paths (closes #321) */
function buildContent(text: string, attachments?: AttachmentRef[]): Anthropic.MessageParam["content"] {
  if (!attachments || attachments.length === 0) return text;
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];
  for (const att of attachments) {
    try {
      if (!existsSync(att.path)) continue;
      const mime = att.mime || guessMime(att.path);
      if (mime.startsWith("image/")) {
        const data = readFileSync(att.path).toString("base64");
        const validMime = (["image/jpeg","image/png","image/gif","image/webp"].includes(mime) ? mime : "image/png") as "image/png";
        blocks.push({ type: "image", source: { type: "base64", media_type: validMime, data } });
      } else if (mime === "application/pdf") {
        const data = readFileSync(att.path).toString("base64");
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } } as unknown as Anthropic.Messages.ContentBlockParam);
      } else {
        // Text, markdown, JSON, etc — include inline
        const content = readFileSync(att.path, "utf-8").slice(0, 8000);
        blocks.push({ type: "text", text: `[Attachment: ${att.name}]\n${content}` });
      }
    } catch { /* skip unreadable files */ }
  }
  blocks.push({ type: "text", text });
  return blocks;
}

function guessMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp",
    pdf: "application/pdf",
    txt: "text/plain", md: "text/plain", ts: "text/plain",
    js: "text/plain", json: "application/json",
  };
  return map[ext] || "application/octet-stream";
}

interface AttachmentRef { path: string; name: string; mime?: string; }

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

ПРАВИЛА оформления:
- Gateway operator: всегда "XOR", "AND" или "OR" (НЕ "X" — только полное название)
- Function role: указывай РОЛЬ (например "Менеджер", "Telegram Router"), НЕ имя конкретного исполнителя/агента
- Роль — это ответственность, исполнители назначаются к ролям отдельно в реестре ролей

Операции, которые ты можешь выполнять:
- Создать новый процесс с нуля
- Изменить названия элементов
- Выровнять расположение (вертикально сверху-вниз, горизонтально, по центру)
- Равномерно распределить элементы
- Добавить новый элемент (укажи тип, label, позицию)
- Удалить элемент

Когда нужно СОЗДАТЬ НОВЫЙ процесс, отвечай строго JSON:
{
  "reply": "Что ты создал",
  "create_workflow": {
    "id": "kebab-case-id",
    "name": "Название процесса",
    "version": "1.0",
    "description": "Описание процесса",
    "elements": [
      {"id": "e1", "type": "event", "label": "Начало", "x": 100, "y": 100},
      {"id": "f1", "type": "function", "label": "Шаг 1", "role": "Название роли", "x": 100, "y": 250},
      {"id": "gw1", "type": "gateway", "label": "Условие?", "operator": "XOR", "x": 100, "y": 400},
      {"id": "e2", "type": "event", "label": "Конец", "x": 100, "y": 550}
    ],
    "flow": [["e1", "f1"], ["f1", "gw1"], ["gw1", "e2"]]
  }
}

Когда нужно изменить существующую схему, отвечай строго JSON:
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

Если пользователь спрашивает, где находится кнопка, элемент или раздел — добавь actions с highlight:
{
  "reply": "Вот эта кнопка отвечает за запуск:",
  "actions": [
    { "type": "highlight", "selector": "#btn-start", "message": "Кнопка запуска процесса", "style": "spotlight" }
  ]
}

Selectors: используй CSS-селекторы (#id, .class, [data-attr], button[title="..."] и т.п.).
Style: "spotlight" — затемнение фона; "pointer" — пульсирующий кружок; "outline" — контур без затемнения.

ВАЖНО: отвечай ТОЛЬКО валидным JSON. Без markdown-оберток.`;

async function handleTsunadeChatRequest(
  histKey: string,
  chatId: string,
  message: string,
  schema?: unknown,
  attachments?: AttachmentRef[],
) {
  const rawHistory = await redis.lrange(histKey, 0, -1).catch(() => [] as string[]);
  const history: Anthropic.MessageParam[] = rawHistory.map(r => {
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);

  const schemaContext = schema
    ? `\nТекущая схема процесса:\n${JSON.stringify(schema, null, 2)}`
    : "";

  const userMsg = message + schemaContext;
  const userContent = buildContent(userMsg, attachments);
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: userContent },
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
  let created_workflow: unknown = undefined;
  let actions: unknown[] = [];
  try {
    const parsed = JSON.parse(stripMarkdownFences(rawReply));
    reply = (typeof parsed.reply === "string" ? parsed.reply : null) || parsed.text || parsed.message || rawReply;
    if (parsed.schema_patch) schema_patch = parsed.schema_patch;
    if (Array.isArray(parsed.actions)) actions = parsed.actions;
    if (parsed.create_workflow) {
      const result = await createWorkflow(parsed.create_workflow, { draft: true });
      if (result.errors.length === 0) {
        created_workflow = result.workflow;
      } else {
        reply = reply + ` (Ошибка создания процесса: ${result.errors.join(", ")})`;
      }
    }
  } catch { /* not JSON, use raw text */ }

  await redis.rpush(histKey, JSON.stringify({ role: "user", content: message }));
  await redis.rpush(histKey, JSON.stringify({ role: "assistant", content: rawReply }));
  await redis.ltrim(histKey, -CHAT_MAX_HISTORY * 2, -1);
  await redis.expire(histKey, 7 * 24 * 3600); // 7 days TTL

  return { reply, chat_id: chatId, schema_patch: schema_patch ?? null, created_workflow: created_workflow ?? null, actions };
}

const router = new Hono();

router.use("/tsunade/chat", requireAuth);
router.post("/tsunade/chat", async (c) => {
  const body = await c.req.json<{ message: string; schema?: unknown; chat_id?: string; attachments?: AttachmentRef[] }>().catch(() => null);
  if (!body?.message?.trim()) return c.json({ error: "message required" }, 400);
  const chatId = body.chat_id || randomUUID();
  const histKey = TSUNADE_CHAT_PREFIX + chatId;
  try {
    const result = await handleTsunadeChatRequest(histKey, chatId, body.message, body.schema, body.attachments);
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
  const body = await c.req.json<{ message: string; schema?: unknown; chat_id?: string; attachments?: AttachmentRef[] }>().catch(() => null);
  if (!body?.message?.trim()) return c.json({ error: "message required" }, 400);
  const chatId = body.chat_id || randomUUID();
  const histKey = TSUNADE_CHAT_PREFIX + chatId;
  try {
    const result = await handleTsunadeChatRequest(histKey, chatId, body.message, body.schema, body.attachments);
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

    const firstBlock = response.content[0];
    const rawReply = (firstBlock.type === "text" ? firstBlock.text : "").trim();
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

// --- Unified /ai/chat endpoint (closes #293) ---
// mode=process → Tsunade system prompt
// mode=admin   → Kiba system prompt
// stream=true  → SSE streaming response

const AI_CHAT_TOOLS = [
  {
    name: "assistant_context_drill",
    description: "Get detailed context about a specific element, process, or state visible on the current page",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "What to drill into (e.g. 'selected process', 'open form', 'error state')" },
      },
      required: ["target"],
    },
  },
  {
    name: "assistant_act",
    description: "Request a UI action on the current page (highlight, navigate). The client will execute it.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["highlight", "navigate"] },
        target: { type: "string", description: "CSS selector for highlight, or path for navigate" },
        message: { type: "string", description: "Tooltip text shown to user for highlight actions" },
      },
      required: ["action", "target"],
    },
  },
  {
    name: "assistant_search",
    description: "Search across processes, agents, documents, roles, or the knowledge base",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: { type: "string", enum: ["processes", "agents", "documents", "roles", "kb", "all"], default: "all" },
      },
      required: ["query"],
    },
  },
  {
    name: "assistant_tool_search",
    description: "Search available agent tools and MCP capabilities by name or description",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Tool name or capability keyword" },
      },
      required: ["query"],
    },
  },
] as const;

router.use("/ai/chat", requireAuth);
router.post("/ai/chat", async (c) => {
  const body = await c.req.json<{
    message: string;
    context?: string;
    chat_id?: string;
    mode?: "process" | "admin";
    stream?: boolean;
  }>().catch(() => null);

  if (!body?.message?.trim()) return c.json({ error: "message required" }, 400);

  const mode = body.mode === "admin" ? "admin" : "process";
  const useStream = body.stream === true;
  const chatId = body.chat_id || randomUUID();
  const isNewChat = !body.chat_id;

  const histPrefix = mode === "admin" ? KIBA_CHAT_PREFIX : TSUNADE_CHAT_PREFIX;
  const histKey = histPrefix + chatId;
  const systemPrompt = mode === "admin" ? KIBA_SYSTEM : TSUNADE_SYSTEM;
  const model = mode === "admin" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6";
  const maxHistory = mode === "admin" ? KIBA_CHAT_MAX_HISTORY : CHAT_MAX_HISTORY;

  const rawHistory = await redis.lrange(histKey, 0, -1).catch(() => [] as string[]);
  const history: { role: "user" | "assistant"; content: string }[] = rawHistory
    .map(r => { try { return JSON.parse(r); } catch { return null; } })
    .filter(Boolean);

  const contextBlock = body.context ? `\n\n[Inspector context]\n${body.context}` : "";
  const userMsg = body.message + contextBlock;

  const messages: { role: "user" | "assistant"; content: string }[] = [
    ...history,
    { role: "user", content: userMsg },
  ];

  if (useStream) {
    const enc = new TextEncoder();
    const sse = (data: string) => enc.encode(`data: ${data}\n\n`);

    const stream = new ReadableStream({
      async start(ctrl) {
        if (isNewChat) {
          ctrl.enqueue(sse(JSON.stringify({ type: "chat_id", chat_id: chatId })));
        }
        try {
          const anthropicStream = await _anthropic.messages.create({
            model,
            max_tokens: 2048,
            system: systemPrompt,
            messages,
            stream: true,
          });

          let fullText = "";
          for await (const event of anthropicStream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              fullText += event.delta.text;
              ctrl.enqueue(sse(JSON.stringify({ type: "delta", text: event.delta.text })));
            }
          }

          ctrl.enqueue(sse("[DONE]"));
          ctrl.close();

          // Persist history after stream completes
          await redis.rpush(histKey, JSON.stringify({ role: "user", content: body.message }));
          await redis.rpush(histKey, JSON.stringify({ role: "assistant", content: fullText }));
          await redis.ltrim(histKey, -maxHistory * 2, -1);
          await redis.expire(histKey, 7 * 24 * 3600);

          // Emit inspector event to Konoha bus (separate channel, non-blocking)
          redis.xadd("inspector", "*",
            "page", body.context?.split('\n')[0] ?? "",
            "chat_id", chatId,
            "mode", mode,
          ).catch(() => {});
        } catch (e: any) {
          ctrl.enqueue(sse(JSON.stringify({ type: "error", message: e.message })));
          ctrl.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Chat-Id": chatId,
      },
    });
  }

  // Non-streaming fallback
  try {
    const response = await _anthropic.messages.create({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages,
    });
    const rawReply = (response.content[0] as any).text?.trim() ?? "";
    await redis.rpush(histKey, JSON.stringify({ role: "user", content: body.message }));
    await redis.rpush(histKey, JSON.stringify({ role: "assistant", content: rawReply }));
    await redis.ltrim(histKey, -maxHistory * 2, -1);
    await redis.expire(histKey, 7 * 24 * 3600);
    return c.json({ reply: rawReply, chat_id: chatId });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

router.delete("/ai/chat/:chat_id", requireAuth, async (c) => {
  const id = c.req.param("chat_id");
  // Try both prefixes (mode unknown at delete time)
  await Promise.all([
    redis.del(TSUNADE_CHAT_PREFIX + id).catch(() => {}),
    redis.del(KIBA_CHAT_PREFIX + id).catch(() => {}),
  ]);
  return c.json({ ok: true });
});

export default router;
