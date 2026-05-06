/**
 * session-store.ts — Lightweight work-session metadata for Assistant chats.
 *
 * Each session wraps a chat_id with a title, context binding, and status.
 * Session metadata is stored separately from message history so it can be
 * listed, filtered, and archived without scanning full chat histories.
 */
import { redis } from "./redis";
import { randomUUID } from "crypto";
import { createLogger, silentCatch } from "./logger";
const log = createLogger("session-store");

export type SessionStatus = "active" | "archived";

export interface SessionContext {
  page?: string;
  workflow_id?: string;
  case_id?: string;
  operation_id?: string;
  assistant_id?: string;
}

export interface SessionRecord {
  chat_id: string;
  title: string;
  status: SessionStatus;
  context: SessionContext;
  last_message?: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

const META_PREFIX = "konoha:session:meta:";
const ALL_KEY = "konoha:sessions:all";
const DEFAULT_TTL = 7 * 86400; // 7 days, matches chat history TTL

function metaKey(chatId: string): string { return META_PREFIX + chatId; }

export async function createSession(params: {
  title?: string;
  context?: SessionContext;
  chat_id?: string;
}): Promise<SessionRecord> {
  const chat_id = params.chat_id || randomUUID();
  const now = new Date().toISOString();
  const record: SessionRecord = {
    chat_id,
    title: params.title || "Новая тема",
    status: "active",
    context: params.context || {},
    message_count: 0,
    created_at: now,
    updated_at: now,
  };
  await Promise.all([
    redis.set(metaKey(chat_id), JSON.stringify(record), "EX", DEFAULT_TTL)
      .catch(e => log.error("session create error", { error: e.message })),
    redis.zadd(ALL_KEY, Date.now(), chat_id)
      .catch(silentCatch("session index add")),
  ]);
  return record;
}

export async function getSession(chatId: string): Promise<SessionRecord | null> {
  const raw = await redis.get(metaKey(chatId)).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function updateSession(
  chatId: string,
  patch: {
    title?: string;
    status?: SessionStatus;
    context?: SessionContext;
    last_message?: string;
    message_count?: number;
  },
): Promise<SessionRecord | null> {
  const record = await getSession(chatId);
  if (!record) return null;
  if (patch.title !== undefined) record.title = patch.title;
  if (patch.status !== undefined) record.status = patch.status;
  if (patch.context !== undefined) record.context = { ...record.context, ...patch.context };
  if (patch.last_message !== undefined) record.last_message = patch.last_message;
  if (patch.message_count !== undefined) record.message_count = patch.message_count;
  record.updated_at = new Date().toISOString();
  await Promise.all([
    redis.set(metaKey(chatId), JSON.stringify(record), "EX", DEFAULT_TTL)
      .catch(e => log.error("session update error", { error: e.message })),
    redis.zadd(ALL_KEY, Date.now(), chatId)
      .catch(silentCatch("session index update")),
  ]);
  return record;
}

export async function listSessions(params: {
  status?: SessionStatus;
  limit?: number;
  offset?: number;
} = {}): Promise<{ sessions: SessionRecord[]; total: number }> {
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;

  // Fetch all IDs sorted by updated_at descending
  const ids = await redis.zrevrange(ALL_KEY, 0, -1).catch(() => [] as string[]);
  if (ids.length === 0) return { sessions: [], total: 0 };

  // Load metadata for all sessions
  const raws = await Promise.all(ids.map(id => redis.get(metaKey(id)).catch(() => null)));
  const sessions: SessionRecord[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      const rec: SessionRecord = JSON.parse(raw);
      if (params.status && rec.status !== params.status) continue;
      sessions.push(rec);
    } catch {}
  }

  const total = sessions.length;
  const paged = sessions.slice(offset, offset + limit);
  return { sessions: paged, total };
}

export async function archiveSession(chatId: string): Promise<SessionRecord | null> {
  return updateSession(chatId, { status: "archived" });
}

export async function deleteSession(chatId: string): Promise<boolean> {
  await Promise.all([
    redis.del(metaKey(chatId)).catch(silentCatch("session meta delete")),
    redis.zrem(ALL_KEY, chatId).catch(silentCatch("session index remove")),
    // Also clean up chat history keys
    redis.del("tsunade:chat:" + chatId).catch(silentCatch("session chat delete")),
    redis.del("kiba:chat:" + chatId).catch(silentCatch("session kiba delete")),
  ]);
  return true;
}

/**
 * Auto-title: derive a session title from the first user message.
 * Truncates to 80 chars, strips newlines, uses first sentence or full text.
 */
export function autoTitle(message: string, context?: SessionContext): string {
  const clean = message.replace(/\n/g, " ").trim();
  // Take first sentence if it ends with .!? within first 80 chars
  const sentenceMatch = clean.match(/^(.+?[.!?])\s/);
  if (sentenceMatch && sentenceMatch[1].length <= 80) {
    return sentenceMatch[1];
  }
  // Fallback: first 80 chars
  if (clean.length <= 80) return clean;
  return clean.slice(0, 77) + "...";
}

/**
 * Ensure a session exists for the given chat_id, creating one if needed.
 * Called on each chat interaction to keep session metadata up-to-date.
 */
export async function ensureSession(params: {
  chat_id: string;
  message?: string;
  context?: SessionContext;
  isNewChat: boolean;
}): Promise<SessionRecord> {
  const existing = await getSession(params.chat_id);
  if (existing) {
    const patch: Parameters<typeof updateSession>[1] = {
      message_count: existing.message_count + 1,
    };
    if (params.message) {
      patch.last_message = params.message.slice(0, 120);
    }
    return (await updateSession(params.chat_id, patch))!;
  }

  // New session — create with auto-title or provided title
  const title = params.message ? autoTitle(params.message, params.context) : undefined;
  return createSession({
    chat_id: params.chat_id,
    title,
    context: params.context,
  });
}
