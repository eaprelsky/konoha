/**
 * operation-store.ts — Long-running operation lifecycle for Assistant actions.
 *
 * Tracks async operations (batch deletes, etc.) with status, progress,
 * and final result. Survives frontend reloads via Redis persistence.
 */
import { redis } from "./redis";
import { randomUUID } from "crypto";
import { createLogger, silentCatch } from "./logger";
const log = createLogger("operation-store");

export type OperationStatus = "pending" | "running" | "done" | "error";

export interface OperationRecord {
  operation_id: string;
  action: string;
  status: OperationStatus;
  progress?: string;
  result?: Record<string, unknown>;
  error?: string;
  chat_id: string;
  started_at: string;
  finished_at?: string;
}

const PREFIX = "konoha:operation:";
const DEFAULT_TTL = 86400; // 24 hours

function key(id: string): string { return PREFIX + id; }

export async function createOperation(params: {
  action: string;
  chat_id: string;
}): Promise<OperationRecord> {
  const operation_id = randomUUID();
  const record: OperationRecord = {
    operation_id,
    action: params.action,
    status: "pending",
    chat_id: params.chat_id,
    started_at: new Date().toISOString(),
  };
  await redis.set(key(operation_id), JSON.stringify(record), "EX", DEFAULT_TTL)
    .catch(e => log.error("operation create error", { error: e.message }));
  return record;
}

export async function updateOperation(
  id: string,
  update: { status?: OperationStatus; progress?: string; result?: Record<string, unknown>; error?: string },
): Promise<OperationRecord | null> {
  const raw = await redis.get(key(id)).catch(() => null);
  if (!raw) return null;
  const record: OperationRecord = JSON.parse(raw);
  if (update.status) record.status = update.status;
  if (update.progress !== undefined) record.progress = update.progress;
  if (update.result) record.result = update.result;
  if (update.error) record.error = update.error;
  if (update.status === "done" || update.status === "error") {
    record.finished_at = new Date().toISOString();
  }
  await redis.set(key(id), JSON.stringify(record), "EX", DEFAULT_TTL)
    .catch(e => log.error("operation update error", { error: e.message }));
  return record;
}

export async function getOperation(id: string): Promise<OperationRecord | null> {
  const raw = await redis.get(key(id)).catch(() => null);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function appendOperationCompletion(op: OperationRecord): Promise<void> {
  // Append a system message to the chat history
  const histKey = "tsunade:chat:" + op.chat_id;
  const text = op.status === "done"
    ? `Операция завершена: ${op.progress ?? op.action}.${op.result?.summary ? ' ' + op.result.summary : ''}`
    : `Ошибка операции: ${op.error ?? 'неизвестная ошибка'}`;
  await redis.rpush(histKey, JSON.stringify({ role: "system", content: text }))
    .catch(silentCatch("append operation completion"));
}
