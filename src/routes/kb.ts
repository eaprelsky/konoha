import { Hono } from "hono";
import { randomUUID } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";
import { requireAuth } from "../middleware/auth";
import { generateText } from "../llm";
import { createLogger } from "../logger";
import { redis } from "../redis";
const log = createLogger("routes:kb");

const KB_DIR = "/opt/shared/wiki";
const KB_ALLOWED_EXT = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);

function buildKbTree(dir: string, base: string): unknown[] {
  const entries = readdirSync(dir);
  const nodes: unknown[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = join(base, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      nodes.push({ type: "dir", name: entry, path: rel, children: buildKbTree(full, rel) });
    } else {
      const ext = extname(entry);
      if (KB_ALLOWED_EXT.has(ext)) {
        nodes.push({ type: "file", name: entry, path: rel, size: st.size, ext });
      }
    }
  }
  return nodes;
}

/** Strip markdown code fences that LLMs sometimes wrap JSON in */
function stripMarkdownFences(raw: string): string {
  const m = raw.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  return m ? m[1].trim() : raw;
}

const JIRAIYA_CHAT_PREFIX = "jiraiya:chat:";
const JIRAIYA_CHAT_MAX_HISTORY = 16;
const JIRAIYA_MAX_CONTEXT_CHARS = 12000;

const JIRAIYA_SYSTEM = `Ты — Дзирайя, AI-ассистент базы знаний в системе Konoha.
Ты помогаешь пользователям искать информацию, отвечать на вопросы и работать с корпусом документов.

Ты получаешь фрагменты документов из базы знаний (wiki) как контекст.
Отвечай строго на основе предоставленных документов. Если информации нет — скажи об этом честно.

Формат ответа — строго валидный JSON (без markdown-оберток):
{
  "reply": "Ответ на вопрос",
  "sources": ["путь/к/файлу1.md", "путь/к/файлу2.md"]
}

Правила:
- Цитируй только из предоставленного контекста
- Указывай источники (пути файлов), которые реально использовал в ответе
- Отвечай на том же языке, на котором задан вопрос
- Если вопрос о процессах — предложи открыть соответствующий процесс в редакторе
- Будь краток: 2–5 предложений если не нужно длиннее`;

function loadKbContext(query: string, filePath?: string): { text: string; sources: string[] } {
  const sources: string[] = [];
  const chunks: string[] = [];
  let remaining = JIRAIYA_MAX_CONTEXT_CHARS;

  // Always include the currently open file first
  if (filePath) {
    const full = join(KB_DIR, filePath);
    if (existsSync(full)) {
      try {
        const content = readFileSync(full, "utf-8");
        const chunk = content.slice(0, Math.min(4000, remaining));
        chunks.push(`## ${filePath}\n${chunk}`);
        sources.push(filePath);
        remaining -= chunk.length;
      } catch { /* skip */ }
    }
  }

  // Search and include relevant files
  const q = query.toLowerCase();
  function searchDir(dir: string, base: string) {
    if (remaining <= 0) return;
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (remaining <= 0) break;
      const full = join(dir, entry);
      const rel = join(base, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        searchDir(full, rel);
      } else if (KB_ALLOWED_EXT.has(extname(entry)) && rel !== filePath) {
        try {
          const content = readFileSync(full, "utf-8");
          if (content.toLowerCase().includes(q)) {
            const chunk = content.slice(0, Math.min(2000, remaining));
            chunks.push(`## ${rel}\n${chunk}`);
            sources.push(rel);
            remaining -= chunk.length;
          }
        } catch { /* skip */ }
      }
    }
  }
  try { searchDir(KB_DIR, ""); } catch { /* skip */ }

  return { text: chunks.join("\n\n---\n\n"), sources };
}

const router = new Hono();

router.get("/tree", async (c) => {
  try {
    const tree = buildKbTree(KB_DIR, "");
    return c.json(tree);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

router.get("/file", async (c) => {
  const path = c.req.query("path") || "";
  if (!path || path.includes("..")) return c.json({ error: "Invalid path" }, 400);
  const full = join(KB_DIR, path);
  if (!existsSync(full)) return c.json({ error: "Not found" }, 404);
  try {
    const content = readFileSync(full, "utf-8");
    return c.json({ content, path });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

router.get("/search", async (c) => {
  const q = (c.req.query("q") || "").trim().toLowerCase();
  if (!q) return c.json([]);
  const results: { path: string }[] = [];
  function searchDir(dir: string, base: string) {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = join(base, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        searchDir(full, rel);
      } else if (KB_ALLOWED_EXT.has(extname(entry))) {
        try {
          const content = readFileSync(full, "utf-8").toLowerCase();
          if (content.includes(q)) results.push({ path: rel });
        } catch { /* skip unreadable */ }
      }
    }
  }
  try {
    searchDir(KB_DIR, "");
    return c.json(results.slice(0, 20));
  } catch (e: any) {
    log.error("kb search failed", { error: e.message, query: q });
    return c.json({ error: e.message }, 500);
  }
});

// Jiraiya KB Chat (under /ai/kb-chat)
export const kbChatRouter = new Hono();

kbChatRouter.use("/kb-chat", requireAuth);
kbChatRouter.post("/kb-chat", async (c) => {
  const body = await c.req.json<{ message: string; file_path?: string; chat_id?: string }>().catch(() => null);
  if (!body?.message?.trim()) return c.json({ error: "message required" }, 400);

  const chatId = body.chat_id || randomUUID();
  const histKey = JIRAIYA_CHAT_PREFIX + chatId;

  const rawHistory = await redis.lrange(histKey, 0, -1).catch(() => [] as string[]);
  const history: { role: "user" | "assistant"; content: string }[] = rawHistory.map(r => {
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);

  const { text: kbContext, sources } = loadKbContext(body.message, body.file_path);
  const contextBlock = kbContext
    ? `\n\nКонтекст из базы знаний:\n${kbContext}`
    : "\n\n(База знаний пуста или нет релевантных документов.)";

  const userMsg = body.message + contextBlock;
  const messages: { role: "user" | "assistant"; content: string }[] = [
    ...history,
    { role: "user", content: userMsg },
  ];

  try {
    const rawReply = await generateText({
      model: "claude-haiku-4-5-20251001",
      maxTokens: 1500,
      system: JIRAIYA_SYSTEM,
      messages,
    });
    let reply = rawReply;
    let replySources: string[] = sources.slice(0, 5);
    try {
      const parsed = JSON.parse(stripMarkdownFences(rawReply));
      reply = (typeof parsed.reply === "string" ? parsed.reply : null) || parsed.text || parsed.message || rawReply;
      if (Array.isArray(parsed.sources)) replySources = parsed.sources;
    } catch { /* use raw */ }

    await redis.rpush(histKey, JSON.stringify({ role: "user", content: body.message }));
    await redis.rpush(histKey, JSON.stringify({ role: "assistant", content: rawReply }));
    await redis.ltrim(histKey, -JIRAIYA_CHAT_MAX_HISTORY * 2, -1);
    await redis.expire(histKey, 3 * 24 * 3600);

    return c.json({ reply, chat_id: chatId, sources: replySources });
  } catch (e: any) {
    log.error("kb chat failed", { error: e.message, chat_id: chatId });
    return c.json({ error: e.message }, 500);
  }
});

kbChatRouter.delete("/kb-chat/:chat_id", requireAuth, async (c) => {
  const chatId = c.req.param("chat_id");
  await redis.del(JIRAIYA_CHAT_PREFIX + chatId).catch(() => {});
  return c.json({ ok: true });
});

export default router;
