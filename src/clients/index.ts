/**
 * index.ts — API Clients factory and exports.
 *
 * Single source of truth for client initialization.
 * MCP servers and Data Adapters receive ready-made client instances.
 */

export { BitrixClient } from "./bitrix";
export { TelegramClient } from "./telegram";
export { TrackerClient } from "./tracker";
export type { ApiClientConfig } from "./types";
export type { WebhookRegistration } from "./bitrix";
export type { TgMessage, TgUpdate } from "./telegram";
export type { TrackerIssue, TrackerClientConfig } from "./tracker";

import { BitrixClient } from "./bitrix";
import { TelegramClient } from "./telegram";
import { TrackerClient } from "./tracker";

export interface AppConfig {
  BITRIX24_WEBHOOK_URL?: string;
  BITRIX_RATE_LIMIT_RPS?: number;
  TELEGRAM_BOT_TOKEN?: string;
  TRACKER_TOKEN?: string;
  TRACKER_CLOUD_ORG_ID?: string;
  TRACKER_BASE_URL?: string;
}

export function createClients(config: AppConfig) {
  const bitrix = new BitrixClient({
    baseUrl: config.BITRIX24_WEBHOOK_URL ?? "",
    token: "", // token is embedded in webhook URL for Bitrix24
    rateLimitRps: config.BITRIX_RATE_LIMIT_RPS ?? 2,
  });

  const telegram = new TelegramClient({
    baseUrl: "https://api.telegram.org",
    token: config.TELEGRAM_BOT_TOKEN ?? "",
  });

  const tracker = new TrackerClient({
    baseUrl: config.TRACKER_BASE_URL ?? "https://api.tracker.yandex.net/v2",
    token: config.TRACKER_TOKEN ?? "",
    orgId: config.TRACKER_CLOUD_ORG_ID ?? "",
  });

  return { bitrix, telegram, tracker };
}
