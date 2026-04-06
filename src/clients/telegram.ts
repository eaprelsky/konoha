/**
 * telegram.ts — Telegram Bot API Client.
 *
 * Handles HTTP and authorization for Telegram Bot API.
 * Does not know about MCP, Event Manager, or adapters — pure API layer.
 *
 * Config: token = TELEGRAM_BOT_TOKEN.
 */

import type { ApiClientConfig } from "./types";

export interface TgMessage {
  message_id: number;
  chat?: { id: number };
  text?: string;
  photo?: unknown[];
  document?: unknown;
  voice?: unknown;
  audio?: unknown;
  [key: string]: unknown;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { data?: string; message?: TgMessage };
  [key: string]: unknown;
}

export class TelegramClient {
  private token: string;
  private apiBase: string;

  constructor(config: ApiClientConfig) {
    this.token = config.token;
    const base = (config.baseUrl || "https://api.telegram.org").replace(/\/$/, "");
    this.apiBase = `${base}/bot${this.token}`;
  }

  async callMethod(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.token) throw new Error("TelegramClient: token not configured");

    const resp = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });

    const data = await resp.json() as { ok: boolean; result?: unknown; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method} error: ${data.description ?? "unknown"}`);
    return data.result;
  }

  async getChatMemberCount(chatId: string | number): Promise<number> {
    return this.callMethod("getChatMembersCount", { chat_id: chatId }) as Promise<number>;
  }
}
