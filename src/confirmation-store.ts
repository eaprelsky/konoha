/**
 * confirmation-store.ts — Persisted confirmation lifecycle for Assistant destructive actions.
 *
 * Stores pending confirmations in Redis with TTL so they survive frontend reloads,
 * prevent double execution, and allow explicit cancel.
 */
import { redis } from "./redis";
import { randomUUID } from "crypto";
import { createLogger, silentCatch } from "./logger";
const log = createLogger("confirmation-store");

export type ConfirmationStatus = "required" | "confirmed" | "cancelled" | "expired";

export interface ConfirmationRecord {
  id: string;
  action: string;
  title: string;
  summary: string;
  status: ConfirmationStatus;
  params: Record<string, unknown>;
  chat_id: string;
  session_id: string;
  created_at: string;
  expires_at: string;
}

const PREFIX = "konoha:confirmation:";
const DEFAULT_TTL = 3600; // 1 hour

function key(id: string): string {
  return PREFIX + id;
}

export async function createConfirmation(params: {
  action: string;
  title: string;
  summary: string;
  params: Record<string, unknown>;
  chat_id: string;
  session_id?: string;
  ttl?: number;
}): Promise<ConfirmationRecord> {
  const id = randomUUID();
  const now = new Date();
  const ttl = params.ttl ?? DEFAULT_TTL;
  const record: ConfirmationRecord = {
    id,
    action: params.action,
    title: params.title,
    summary: params.summary,
    status: "required",
    params: params.params,
    chat_id: params.chat_id,
    session_id: params.session_id ?? params.chat_id,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
  };

  await redis
    .set(key(id), JSON.stringify(record), "EX", ttl)
    .catch(e => log.error("confirmation create error", { error: e.message }));

  return record;
}

export async function getConfirmation(id: string): Promise<ConfirmationRecord | null> {
  const raw = await redis.get(key(id)).catch(() => null);
  if (!raw) return null;
  try {
    const record: ConfirmationRecord = JSON.parse(raw);
    if (record.status === "expired" || new Date(record.expires_at) < new Date()) {
      if (record.status === "required") {
        record.status = "expired";
        await redis.set(key(id), JSON.stringify(record), "EX", 60).catch(silentCatch("expire confirmation"));
      }
    }
    return record;
  } catch {
    return null;
  }
}

export async function confirmConfirmation(
  id: string,
  result?: Record<string, unknown>,
): Promise<ConfirmationRecord | null> {
  const record = await getConfirmation(id);
  if (!record) return null;
  if (record.status !== "required") return record; // already resolved
  record.status = "confirmed";
  if (result) record.params = { ...record.params, _confirmed_result: result };
  await redis
    .set(key(id), JSON.stringify(record), "EX", 300) // keep for 5 min after confirm
    .catch(e => log.error("confirmation confirm error", { error: e.message }));
  return record;
}

export async function cancelConfirmation(id: string): Promise<ConfirmationRecord | null> {
  const record = await getConfirmation(id);
  if (!record) return null;
  if (record.status !== "required") return record;
  record.status = "cancelled";
  await redis
    .set(key(id), JSON.stringify(record), "EX", 300)
    .catch(e => log.error("confirmation cancel error", { error: e.message }));
  return record;
}

export async function listPendingConfirmations(
  chatId?: string,
): Promise<ConfirmationRecord[]> {
  // We can't list by pattern easily in Redis without SCAN, so for now
  // confirmations are looked up by explicit IDs from the frontend.
  // This function supports a future listing endpoint.
  const pattern = PREFIX + "*";
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 50).catch(() => ["0", []] as [string, string[]]);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0" && keys.length < 100);

  const records: ConfirmationRecord[] = [];
  for (const k of keys) {
    const raw = await redis.get(k).catch(() => null);
    if (!raw) continue;
    try {
      const r: ConfirmationRecord = JSON.parse(raw);
      if (r.status === "required" && (!chatId || r.chat_id === chatId)) {
        records.push(r);
      }
    } catch {}
  }
  return records;
}
