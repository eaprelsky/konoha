/**
 * bitrix.ts — Bitrix24 API Client.
 *
 * Handles HTTP, authorization, retry, and rate limiting for Bitrix24 REST API.
 * Does not know about MCP, Event Manager, or adapters — pure API layer.
 *
 * Config: baseUrl = BITRIX24_WEBHOOK_URL (token embedded in URL for webhook auth).
 * Rate limit: Bitrix24 cloud allows 2 RPS by default.
 */

import type { ApiClientConfig } from "./types";

export interface WebhookRegistration {
  event: string;
  handler: string;
}

export class BitrixClient {
  private baseUrl: string;
  private retryAttempts: number;
  private retryDelay: number;
  private minIntervalMs: number;
  private _lastCallTime = 0;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.retryAttempts = config.retryAttempts ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
    this.minIntervalMs = config.rateLimitRps ? Math.ceil(1000 / config.rateLimitRps) : 500;
  }

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this._lastCallTime;
    if (elapsed < this.minIntervalMs) {
      await new Promise(res => setTimeout(res, this.minIntervalMs - elapsed));
    }
    this._lastCallTime = Date.now();
  }

  async callMethod(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.baseUrl) throw new Error("BitrixClient: baseUrl not configured");
    await this.throttle();

    const url = `${this.baseUrl}/${method}.json`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise(res => setTimeout(res, this.retryDelay * Math.pow(2, attempt - 1)));
      }
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw new Error(`Bitrix24 ${method} HTTP ${resp.status}: ${text}`);
        }

        const data = await resp.json() as Record<string, unknown>;
        if (data.error) {
          throw new Error(`Bitrix24 ${method} error: ${data.error} — ${data.error_description ?? ""}`);
        }
        return data.result;
      } catch (e) {
        lastError = e as Error;
        // Don't retry on client-side errors
        if (lastError.message.includes("HTTP 4")) break;
      }
    }
    throw lastError!;
  }

  // ── CRM methods ──────────────────────────────────────────────────────────────

  async getLeads(filter: Record<string, unknown> = {}, select = ["ID"]): Promise<Record<string, unknown>[]> {
    return this.callMethod("crm.lead.list", { filter, select }) as Promise<Record<string, unknown>[]>;
  }

  async getDeals(filter: Record<string, unknown> = {}, select = ["ID"]): Promise<Record<string, unknown>[]> {
    return this.callMethod("crm.deal.list", { filter, select }) as Promise<Record<string, unknown>[]>;
  }

  async getContacts(filter: Record<string, unknown> = {}, select = ["ID"]): Promise<Record<string, unknown>[]> {
    return this.callMethod("crm.contact.list", { filter, select }) as Promise<Record<string, unknown>[]>;
  }

  async getCompanies(filter: Record<string, unknown> = {}, select = ["ID"]): Promise<Record<string, unknown>[]> {
    return this.callMethod("crm.company.list", { filter, select }) as Promise<Record<string, unknown>[]>;
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────

  async registerWebhook(event: string, handler: string): Promise<WebhookRegistration> {
    await this.callMethod("event.bind", { event: event.toUpperCase(), handler });
    return { event: event.toUpperCase(), handler };
  }

  async unregisterWebhook(event: string, handler: string): Promise<void> {
    await this.callMethod("event.unbind", { event: event.toUpperCase(), handler });
  }
}
