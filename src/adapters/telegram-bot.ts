/**
 * telegram-bot.ts — Telegram Bot API DataAdapter implementation.
 *
 * EventListener: reads from Redis stream `telegram:bot:incoming` via consumer
 *   group "event-manager". Grammy bot remains the sole Bot API consumer —
 *   no direct getUpdates calls from this adapter (avoids 409 conflicts).
 *   filter fields: message_type ("text"|"photo"|"document"|"voice"|"audio"|"callback"),
 *                  chat_id (number or string).
 *
 * DataQuery: getChatMembersCount (still uses Bot API directly — no conflict).
 *
 * Config: TELEGRAM_BOT_TOKEN env var.
 */

import { randomUUID } from "crypto";
import Redis from "ioredis";
import type { DataAdapter, ListenerHandle, QueryParams } from "./data-adapter";
import { listenerRegistry } from "./data-adapter";
import { TelegramClient } from "../clients/telegram";
import type { TgMessage, TgUpdate } from "../clients/telegram";
import { redis as sharedRedis, REDIS_CONNECTION_OPTS } from "../redis";

const STREAM_KEY = "telegram:bot:incoming";
const CONSUMER_GROUP = "event-manager";
const CONSUMER_NAME = "telegram-bot-adapter-worker";
const BLOCK_MS = 5000;
const BATCH_SIZE = 10;

// ── Helpers ───────────────────────────────────────────────────────────────────

function messageTypeOf(msg: TgMessage): string {
  if (msg.text !== undefined) return "text";
  if (msg.photo) return "photo";
  if (msg.document) return "document";
  if (msg.voice) return "voice";
  if (msg.audio) return "audio";
  return "other";
}

/**
 * Reconstruct a TgUpdate from the flat field dict written by Grammy.
 * If Grammy included `update_json` (full raw update), parse that.
 * Otherwise build a compatible struct from the flat extracted fields.
 */
function streamEntryToUpdate(fields: Record<string, string>): TgUpdate {
  if (fields.update_json) {
    try { return JSON.parse(fields.update_json) as TgUpdate; } catch { /* fall through */ }
  }
  const chatId = parseInt(fields.chat_id, 10) || 0;
  const messageId = parseInt(fields.message_id, 10) || 0;
  const kind = fields.attachment_kind;
  const msg: TgMessage = {
    message_id: messageId,
    chat: { id: chatId },
    date: fields.ts ? Math.floor(new Date(fields.ts).getTime() / 1000) : 0,
    text: (!kind && fields.text) ? fields.text : undefined,
    ...(kind === "photo"    ? { photo: [{ file_id: fields.attachment_file_id ?? "" }] } : {}),
    ...(kind === "document" ? { document: { file_id: fields.attachment_file_id ?? "" } } : {}),
    ...(kind === "voice"    ? { voice:    { file_id: fields.attachment_file_id ?? "" } } : {}),
    ...(kind === "audio"    ? { audio:    { file_id: fields.attachment_file_id ?? "" } } : {}),
  };
  return { update_id: messageId, message: msg };
}

function matchesFilter(update: TgUpdate, filter: Record<string, unknown>): boolean {
  const isCallback = !!update.callback_query;
  const msg = update.message ?? update.callback_query?.message;
  if (!msg) return false;

  if (filter.chat_id !== undefined) {
    const msgId = msg.chat?.id;
    // Accept filter.chat_id as number or numeric string
    const filterId = typeof filter.chat_id === "string"
      ? parseInt(filter.chat_id, 10) : Number(filter.chat_id);
    if (msgId !== filterId) return false;
  }

  if (filter.message_type !== undefined) {
    const actualType = isCallback ? "callback" : messageTypeOf(msg);
    if (actualType !== filter.message_type) return false;
  }

  return true;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class TelegramBotAdapter implements DataAdapter {
  readonly name = "telegram";

  private client: TelegramClient;
  private redisReader: Redis | null = null;
  private loopActive = false;
  private listenerFilters = new Map<string, Record<string, unknown>>();

  constructor(client: TelegramClient) {
    this.client = client;
  }

  // ── Consumer group bootstrap ──────────────────────────────────────────────

  private async ensureConsumerGroup(): Promise<void> {
    try {
      // "$" = only new messages after this group was created
      await sharedRedis.xgroup("CREATE", STREAM_KEY, CONSUMER_GROUP, "$", "MKSTREAM");
      console.log(`[telegram-bot] consumer group "${CONSUMER_GROUP}" created on ${STREAM_KEY}`);
    } catch (e: any) {
      if (e.message?.includes("BUSYGROUP")) {
        // Group already exists — expected on restart
      } else {
        console.error(`[telegram-bot] xgroup CREATE error: ${e.message}`);
      }
    }
  }

  // ── Redis read loop (replaces getUpdates pollLoop) ────────────────────────

  private async redisLoop(): Promise<void> {
    // Dedicated connection for blocking XREADGROUP — must not share with non-blocking ops
    this.redisReader = new Redis(REDIS_CONNECTION_OPTS);

    while (this.loopActive) {
      try {
        const result = await this.redisReader.xreadgroup(
          "GROUP", CONSUMER_GROUP, CONSUMER_NAME,
          "COUNT", BATCH_SIZE,
          "BLOCK", BLOCK_MS,
          "STREAMS", STREAM_KEY, ">",
        ) as [string, [string, string[]][]][] | null;

        if (!result) continue;

        for (const [, entries] of result) {
          for (const [entryId, rawFields] of entries) {
            // Parse flat fields array → object
            const fields: Record<string, string> = {};
            for (let i = 0; i < rawFields.length; i += 2) {
              fields[rawFields[i]] = rawFields[i + 1];
            }

            let matched = false;
            try {
              const update = streamEntryToUpdate(fields);
              for (const [handleId, filter] of this.listenerFilters.entries()) {
                if (matchesFilter(update, filter)) {
                  matched = true;
                  const cb = listenerRegistry.get(handleId);
                  if (cb) {
                    try { cb(update); }
                    catch (cbErr: any) {
                      console.error(`[telegram-bot] callback error handle=${handleId}: ${cbErr.message}`);
                    }
                  }
                }
              }
            } catch (parseErr: any) {
              console.error(`[telegram-bot] parse error entry=${entryId}: ${parseErr.message}`);
            }

            // Always ACK — no retry on callback errors to avoid infinite loops
            await sharedRedis.xack(STREAM_KEY, CONSUMER_GROUP, entryId).catch(() => {});

            if (matched) {
              console.log(`[telegram-bot] dispatched entry=${entryId} chat=${fields.chat_id}`);
            }
          }
        }
      } catch (e: any) {
        if (!this.loopActive) break;
        console.error(`[telegram-bot] redis loop error: ${e.message}`);
        await new Promise(res => setTimeout(res, 3000));
      }
    }

    this.redisReader?.disconnect();
    this.redisReader = null;
  }

  private async ensureLoop(): Promise<void> {
    if (this.loopActive) return;
    await this.ensureConsumerGroup();
    this.loopActive = true;
    this.redisLoop().catch(e => console.error(`[telegram-bot] redis loop crashed: ${e.message}`));
    console.log("[telegram-bot] redis stream listener started");
  }

  private stopLoopIfIdle(): void {
    if (this.listenerFilters.size === 0) {
      this.loopActive = false;
      console.log("[telegram-bot] redis stream listener stopped (no listeners)");
    }
  }

  // ── DataAdapter interface ─────────────────────────────────────────────────

  async setupListener(
    filter: Record<string, unknown>,
    callback: (payload: unknown) => void,
  ): Promise<ListenerHandle> {
    const handleId = randomUUID();
    listenerRegistry.set(handleId, callback);
    this.listenerFilters.set(handleId, filter);
    await this.ensureLoop();
    console.log(`[telegram-bot] listener registered handle=${handleId} filter=${JSON.stringify(filter)}`);
    return { id: handleId, adapter: this.name };
  }

  async removeListener(handle: ListenerHandle): Promise<void> {
    listenerRegistry.delete(handle.id);
    this.listenerFilters.delete(handle.id);
    this.stopLoopIfIdle();
    console.log(`[telegram-bot] listener removed handle=${handle.id}`);
  }

  async executeQuery(query: QueryParams): Promise<number> {
    const { entity, filter, metric } = query;

    if (entity === "chat_members" || entity === "members") {
      if (filter.chat_id === undefined) {
        throw new Error("TelegramBotAdapter.executeQuery: filter.chat_id required");
      }
      const count = await this.client.getChatMemberCount(filter.chat_id as string | number);
      return metric === "exists" ? (count > 0 ? 1 : 0) : count;
    }

    throw new Error(`TelegramBotAdapter.executeQuery: unsupported entity "${entity}"`);
  }
}

// Singleton
export const telegramBotAdapter = new TelegramBotAdapter(
  new TelegramClient({
    baseUrl: "https://api.telegram.org",
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
  }),
);
