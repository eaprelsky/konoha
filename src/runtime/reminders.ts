/**
 * reminders.ts — Reminder CRUD + BullMQ scheduler.
 * Extracted from runtime.ts (issue #338).
 */
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { Queue, Worker } from "bullmq";
import { redis, REDIS_CONNECTION_OPTS } from "../redis";
import { pgUpsertReminder, pgDeleteReminder, pgGetReminder, pgListReminders } from "../storage/pg";
import { createLogger } from "../logger";
import { isPgReadEnabledFor } from "../storage/pg-read-flags";
import {
  enqueueRuntimeEffect,
  type RuntimeEffectEnqueueResult,
  type RuntimeEffectHandlerResult,
  type RuntimeEffectRecord,
  type RuntimeEffectRetryPolicy,
} from "../runtime-effect-outbox";

const log = createLogger("runtime:reminders");

const REMINDER_KEY_PREFIX = "reminder:";
const REMINDERS_IDX_ALL = "konoha:reminders:all";
const REMINDERS_IDX_STATUS = "konoha:reminders:status:";
const REMINDER_QUEUE_NAME = "reminder-scheduler";

export type ReminderStatus = "pending" | "sent" | "acknowledged" | "overdue";
export type ReminderChannel = "gui" | "telegram" | "email";
export type ReminderType = "standalone" | "process-bound";

export interface Reminder {
  reminder_id: string;
  type: ReminderType;
  recipient: string;
  message: string;
  scheduled_at: string;
  channel: ReminderChannel;
  status: ReminderStatus;
  case_id?: string;
  process_id?: string;
  element_id?: string;
  work_item_id?: string;
  created_at: string;
  updated_at: string;
}

function isoStr(v: unknown): string {
  if (!v) return new Date().toISOString();
  return v instanceof Date ? v.toISOString() : String(v);
}

function pgRowToReminder(row: Record<string, unknown>): Reminder {
  return {
    reminder_id: String(row.id),
    type: (row.type ?? 'standalone') as ReminderType,
    recipient: String(row.recipient ?? ''),
    message: String(row.message ?? ''),
    scheduled_at: isoStr(row.scheduled_at),
    channel: (row.channel ?? 'telegram') as ReminderChannel,
    status: (row.status ?? 'pending') as ReminderStatus,
    case_id: row.case_id ? String(row.case_id) : undefined,
    process_id: row.process_id ? String(row.process_id) : undefined,
    element_id: row.element_id ? String(row.element_id) : undefined,
    work_item_id: row.work_item_id ? String(row.work_item_id) : undefined,
    created_at: isoStr(row.created_at),
    updated_at: isoStr(row.updated_at),
  };
}

async function saveReminder(r: Reminder, prevStatus?: ReminderStatus): Promise<void> {
  await redis.set(REMINDER_KEY_PREFIX + r.reminder_id, JSON.stringify(r));
  pgUpsertReminder({ id: r.reminder_id, type: r.type, recipient: r.recipient, message: r.message, scheduled_at: r.scheduled_at, channel: r.channel, status: r.status, case_id: r.case_id, process_id: r.process_id, element_id: r.element_id, work_item_id: r.work_item_id, updated_at: new Date().toISOString() });
  if (prevStatus && prevStatus !== r.status) {
    await redis.srem(REMINDERS_IDX_STATUS + prevStatus, r.reminder_id);
  }
  await redis.sadd(REMINDERS_IDX_STATUS + r.status, r.reminder_id);
  await redis.zadd(REMINDERS_IDX_ALL, new Date(r.scheduled_at).getTime(), r.reminder_id);
}

async function loadReminder(reminder_id: string): Promise<Reminder | null> {
  if (isPgReadEnabledFor("reminders")) {
    const row = await pgGetReminder(reminder_id);
    return row ? pgRowToReminder(row) : null;
  }
  const raw = await redis.get(REMINDER_KEY_PREFIX + reminder_id);
  return raw ? JSON.parse(raw) : null;
}

const reminderQueue = new Queue(REMINDER_QUEUE_NAME, { connection: REDIS_CONNECTION_OPTS });
let reminderWorker: Worker | null = null;

export const reminderScheduleOutboxHooks = {
  scheduleReminderJob,
};

async function fireReminder(reminder_id: string): Promise<void> {
  const r = await loadReminder(reminder_id);
  if (!r || r.status !== "pending") return;

  // Reminder is a notification layer only — it does NOT advance the process.
  // Process-time waits (timer-based advancement) are handled by TimerWait + tickTimerWaits().
  // This separation ensures reminders never auto-complete work items by themselves.
  log.info("reminder fired (notification only, no process advancement)", {
    reminder_id,
    type: r.type,
    recipient: r.recipient,
    case_id: r.case_id,
    work_item_id: r.work_item_id,
  });

  await updateReminderStatus(reminder_id, "sent");

  if (r.channel === "telegram") {
    try {
      const trustedUsers = JSON.parse(readFileSync("/opt/shared/.trusted-users.json", "utf-8"));
      const allUsers = [trustedUsers.owner, ...(trustedUsers.trusted ?? [])];
      const recipientClean = r.recipient.replace(/^@/, "");
      const user = allUsers.find((u: { name: string; username?: string; telegram_id: number }) =>
        u.name === r.recipient ||
        u.username === recipientClean ||
        String(u.telegram_id) === r.recipient
      );
      if (user) {
        await redis.xadd(
          "telegram:outgoing",
          "*",
          "chat_id",
          String(user.telegram_id),
          "text",
          `[Напоминание] ${r.message}`,
        ).catch(e => log.warn("failed to send reminder notification", { reminder_id: r.reminder_id, error: e?.message }));
      }
    } catch (e: any) {
      log.warn("reminder poll error", { error: e?.message });
    }
  }
}

async function scheduleReminderJob(r: Reminder): Promise<void> {
  const delayMs = Math.max(0, new Date(r.scheduled_at).getTime() - Date.now());
  const existing = await reminderQueue.getJob(r.reminder_id).catch(() => null);
  if (existing) return;
  await reminderQueue.add("fire", { reminder_id: r.reminder_id }, {
    jobId: r.reminder_id,
    delay: delayMs,
    removeOnComplete: true,
    removeOnFail: { count: 3 },
  });
  log.info("queued reminder", { reminder_id: r.reminder_id, delay_ms: delayMs });
}

export function reminderScheduleIdempotencyKey(reminderId: string): string {
  return `reminder.schedule:${reminderId}`;
}

export async function enqueueReminderScheduleEffect(
  reminder: Reminder,
  now = new Date().toISOString(),
  retryPolicy?: Partial<RuntimeEffectRetryPolicy>,
): Promise<RuntimeEffectEnqueueResult> {
  return enqueueRuntimeEffect({
    kind: "reminder.schedule",
    idempotency_key: reminderScheduleIdempotencyKey(reminder.reminder_id),
    payload: {
      operation: "schedule",
      reminder_id: reminder.reminder_id,
      scheduled_at: reminder.scheduled_at,
      status: reminder.status,
      channel: reminder.channel,
      recipient: reminder.recipient,
    },
    links: {
      ...(reminder.process_id ? { workflow_id: reminder.process_id } : {}),
      ...(reminder.case_id ? { case_id: reminder.case_id } : {}),
      ...(reminder.work_item_id ? { work_item_id: reminder.work_item_id } : {}),
      ...(reminder.element_id ? { event_id: reminder.element_id } : {}),
      action_type: "reminder.schedule",
      action_trace_id: reminder.reminder_id,
    },
    ...(retryPolicy ? { retry_policy: retryPolicy } : {}),
  }, now);
}

function reminderEffectFail(code: string, message: string, details?: Record<string, unknown>): never {
  throw Object.assign(new Error(message), { code, retryable: false, details });
}

function reminderIdFromEffect(record: RuntimeEffectRecord): string {
  const value = record.payload.reminder_id;
  if (typeof value !== "string" || !value.trim()) {
    reminderEffectFail("REMINDER_SCHEDULE_PAYLOAD_INVALID", "reminder.schedule payload.reminder_id is required", { key: "reminder_id" });
  }
  if (record.links.action_trace_id && record.links.action_trace_id !== value) {
    reminderEffectFail("REMINDER_SCHEDULE_LINK_MISMATCH", "reminder.schedule reminder_id does not match action_trace_id", {
      action_trace_id: record.links.action_trace_id,
      payload_reminder_id: value,
    });
  }
  return value;
}

export async function handleReminderScheduleEffect(record: RuntimeEffectRecord): Promise<RuntimeEffectHandlerResult> {
  if (record.kind !== "reminder.schedule") {
    reminderEffectFail("RUNTIME_EFFECT_KIND_UNSUPPORTED", `Unsupported reminder runtime effect kind: ${record.kind}`, { kind: record.kind });
  }
  const reminderId = reminderIdFromEffect(record);
  const reminder = await loadReminder(reminderId);
  if (!reminder) {
    reminderEffectFail("REMINDER_SCHEDULE_REMINDER_MISSING", `Reminder "${reminderId}" not found`, { reminder_id: reminderId });
  }
  if (reminder.status !== "pending") {
    return {
      receipt: {
        data: {
          reminder_id: reminder.reminder_id,
          scheduled: false,
          status: reminder.status,
          reason: "reminder_not_pending",
        },
      },
    };
  }
  await reminderScheduleOutboxHooks.scheduleReminderJob(reminder);
  return {
    receipt: {
      data: {
        reminder_id: reminder.reminder_id,
        scheduled: true,
        scheduled_at: reminder.scheduled_at,
        channel: reminder.channel,
      },
    },
  };
}

export async function createReminder(params: {
  type: ReminderType;
  recipient: string;
  message: string;
  scheduled_at: string;
  channel: ReminderChannel;
  case_id?: string;
  process_id?: string;
  element_id?: string;
  work_item_id?: string;
}): Promise<Reminder> {
  const now = new Date().toISOString();
  const r: Reminder = {
    reminder_id: randomUUID(),
    type: params.type,
    recipient: params.recipient,
    message: params.message,
    scheduled_at: params.scheduled_at,
    channel: params.channel,
    status: "pending",
    case_id: params.case_id,
    process_id: params.process_id,
    element_id: params.element_id,
    work_item_id: params.work_item_id,
    created_at: now,
    updated_at: now,
  };
  await saveReminder(r);
  try {
    await enqueueReminderScheduleEffect(r);
  } catch (e) {
    await deleteReminder(r.reminder_id).catch(err =>
      log.warn("failed to rollback reminder after schedule effect enqueue failure", { reminder_id: r.reminder_id, error: err?.message }),
    );
    throw e;
  }
  return r;
}

export async function listReminders(filters: {
  status?: ReminderStatus;
  recipient?: string;
} = {}): Promise<Reminder[]> {
  if (isPgReadEnabledFor("reminders")) {
    const rows = await pgListReminders({ status: filters.status });
    let result = rows.map(pgRowToReminder);
    if (filters.recipient) result = result.filter(r => r.recipient === filters.recipient);
    return result;
  }

  let ids: string[];
  if (filters.status) {
    ids = await redis.smembers(REMINDERS_IDX_STATUS + filters.status);
  } else {
    ids = await redis.zrange(REMINDERS_IDX_ALL, 0, -1);
  }
  const reminders = await Promise.all(ids.map(id => loadReminder(id)));
  let result = reminders.filter((r): r is Reminder => r !== null);
  if (filters.recipient) {
    result = result.filter(r => r.recipient === filters.recipient);
  }
  result.sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
  return result;
}

export async function updateReminderStatus(
  reminder_id: string,
  status: ReminderStatus,
): Promise<Reminder> {
  const r = await loadReminder(reminder_id);
  if (!r) throw new Error(`Reminder "${reminder_id}" not found`);
  const prev = r.status;
  r.status = status;
  r.updated_at = new Date().toISOString();
  await saveReminder(r, prev);
  return r;
}

export async function deleteReminder(reminder_id: string): Promise<void> {
  const r = await loadReminder(reminder_id);
  if (!r) throw new Error(`Reminder "${reminder_id}" not found`);
  await redis.del(REMINDER_KEY_PREFIX + reminder_id);
  await redis.srem(REMINDERS_IDX_STATUS + r.status, reminder_id);
  await redis.zrem(REMINDERS_IDX_ALL, reminder_id);
  pgDeleteReminder(reminder_id);
  const job = await reminderQueue.getJob(reminder_id).catch(() => null);
  if (job) await job.remove().catch(e => log.warn("failed to remove reminder job", { reminder_id, error: e?.message }));
}

export function startReminderScheduler(): void {
  if (reminderWorker) return;

  reminderWorker = new Worker(
    REMINDER_QUEUE_NAME,
    async (job) => {
      const { reminder_id } = job.data as { reminder_id: string };
      await fireReminder(reminder_id);
    },
    { connection: REDIS_CONNECTION_OPTS },
  );

  reminderWorker.on("failed", (job, err) => {
    log.error("job failed", { job_id: job?.id, error: err.message });
  });

  log.info("bullmq worker started");

  setInterval(async () => {
    try {
      const sent = await listReminders({ status: "sent" });
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      for (const r of sent) {
        if (new Date(r.scheduled_at) < oneDayAgo) {
          await updateReminderStatus(r.reminder_id, "overdue").catch(e => log.warn("failed to mark reminder overdue", { reminder_id: r.reminder_id, error: e?.message }));
        }
      }
    } catch (e: any) {
      log.warn("overdue sweep error", { error: e?.message });
    }
  }, 60_000);
}

export async function restoreReminderJobs(): Promise<void> {
  const pending = await listReminders({ status: "pending" });
  let restored = 0;
  for (const r of pending) {
    const existing = await reminderQueue.getJob(r.reminder_id).catch(() => null);
    if (!existing) {
      await scheduleReminderJob(r);
      restored++;
    }
  }
  if (restored > 0) {
    log.info("restored bullmq jobs on startup", { count: restored });
  }
}
