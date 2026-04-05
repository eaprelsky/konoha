/**
 * telegram-bot.ts — Telegram Bot API DataAdapter implementation.
 *
 * EventListener: long polling via getUpdates, dispatches to registered callbacks.
 *   Multiple listeners share a single polling loop (offset-tracked).
 *   filter fields: message_type ("text"|"photo"|"document"|"callback"|...), chat_id.
 * DataQuery: getChatMembersCount.
 *
 * Config: TELEGRAM_BOT_TOKEN env var.
 */

import { randomUUID } from "crypto";
import type { DataAdapter, ListenerHandle, QueryParams } from "./data-adapter";
import { listenerRegistry } from "./data-adapter";
import { TelegramClient } from "../clients/telegram";
import type { TgMessage, TgUpdate } from "../clients/telegram";

function messageTypeOf(msg: TgMessage): string {
  if (msg.text !== undefined) return "text";
  if (msg.photo) return "photo";
  if (msg.document) return "document";
  if (msg.voice) return "voice";
  if (msg.audio) return "audio";
  return "other";
}

function matchesFilter(update: TgUpdate, filter: Record<string, unknown>): boolean {
  const isCallback = !!update.callback_query;
  const msg = update.message ?? update.callback_query?.message;
  if (!msg) return false;

  if (filter.chat_id !== undefined && msg.chat?.id !== filter.chat_id) return false;

  if (filter.message_type !== undefined) {
    const actualType = isCallback ? "callback" : messageTypeOf(msg);
    if (actualType !== filter.message_type) return false;
  }

  return true;
}

// ── Polling loop (singleton per adapter instance) ─────────────────────────────

export class TelegramBotAdapter implements DataAdapter {
  readonly name = "telegram";
  private client: TelegramClient;
  private pollingActive = false;
  private pollingOffset = 0;
  private listenerFilters = new Map<string, Record<string, unknown>>();

  constructor(client: TelegramClient) {
    this.client = client;
  }

  private async pollLoop(): Promise<void> {
    while (this.pollingActive) {
      try {
        const updates = await this.client.getUpdates(this.pollingOffset, 25);

        for (const update of updates) {
          this.pollingOffset = update.update_id + 1;
          for (const [handleId, filter] of this.listenerFilters.entries()) {
            if (matchesFilter(update, filter)) {
              const cb = listenerRegistry.get(handleId);
              if (cb) {
                try { cb(update); } catch (e: any) {
                  console.error(`[telegram-bot] callback error handle=${handleId}: ${e.message}`);
                }
              }
            }
          }
        }
      } catch (e: any) {
        if (this.pollingActive) {
          console.error(`[telegram-bot] poll error: ${e.message}`);
          await new Promise(res => setTimeout(res, 5000));
        }
      }
    }
  }

  private ensurePolling(): void {
    if (this.pollingActive) return;
    this.pollingActive = true;
    this.pollLoop().catch(e => console.error(`[telegram-bot] poll loop crashed: ${e.message}`));
    console.log("[telegram-bot] long polling started");
  }

  private stopPollingIfIdle(): void {
    if (this.listenerFilters.size === 0) {
      this.pollingActive = false;
      console.log("[telegram-bot] long polling stopped (no listeners)");
    }
  }

  async setupListener(
    filter: Record<string, unknown>,
    callback: (payload: unknown) => void,
  ): Promise<ListenerHandle> {
    const handleId = randomUUID();
    listenerRegistry.set(handleId, callback);
    this.listenerFilters.set(handleId, filter);
    this.ensurePolling();
    console.log(`[telegram-bot] listener registered handle=${handleId} filter=${JSON.stringify(filter)}`);
    return { id: handleId, adapter: this.name };
  }

  async removeListener(handle: ListenerHandle): Promise<void> {
    listenerRegistry.delete(handle.id);
    this.listenerFilters.delete(handle.id);
    this.stopPollingIfIdle();
    console.log(`[telegram-bot] listener removed handle=${handle.id}`);
  }

  /**
   * Supported entities: "chat_members" | "members"
   * filter.chat_id required.
   * metric: "count" | "exists"
   */
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

// Singleton for backward compatibility — initialized from env vars
export const telegramBotAdapter = new TelegramBotAdapter(
  new TelegramClient({
    baseUrl: "https://api.telegram.org",
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
  }),
);
