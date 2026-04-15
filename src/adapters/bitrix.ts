/**
 * bitrix.ts — Bitrix24 DataAdapter implementation.
 *
 * EventListener: incoming webhooks (event.bind / event.unbind via Bitrix REST).
 *   Registered handlers receive payloads dispatched by POST /api/webhooks/bitrix.
 * DataQuery: crm.lead.list / crm.deal.list with filters, returns count or sum.
 *
 * Config: BITRIX24_WEBHOOK_URL env var (e.g. https://knwlab.bitrix24.ru/rest/1/<token>/)
 */

import { randomUUID } from "crypto";
import type { DataAdapter, ListenerHandle, QueryParams } from "./data-adapter";
import { listenerRegistry } from "./data-adapter";
import { BitrixClient } from "../clients/bitrix";
import { createLogger } from "../logger";

const log = createLogger("bitrix");

// External URL where Konoha receives Bitrix24 event pushes
const KONOHA_PUBLIC_URL = (process.env.KONOHA_PUBLIC_URL ?? "http://localhost:3200").replace(/\/$/, "");

// Maps handleId → Bitrix24 event name (for unbind)
const bindedEvents = new Map<string, string>();
// Maps handleId → handler URL (for unbind)
const bindedHandlers = new Map<string, string>();

export class BitrixAdapter implements DataAdapter {
  readonly name = "bitrix";
  private client: BitrixClient;

  constructor(client: BitrixClient) {
    this.client = client;
  }

  /**
   * Register a webhook listener for a Bitrix24 event.
   * filter.event: string — e.g. "ONCRMLEAD ADD", "ONCRMDEALU PDATE"
   * Bitrix24 will POST to KONOHA_PUBLIC_URL/api/webhooks/bitrix on each match.
   */
  async setupListener(
    filter: Record<string, unknown>,
    callback: (payload: unknown) => void,
  ): Promise<ListenerHandle> {
    const event = (filter.event as string | undefined) ?? "";
    if (!event) throw new Error("BitrixAdapter.setupListener: filter.event required");

    const handleId = randomUUID();
    const handlerUrl = `${KONOHA_PUBLIC_URL}/api/webhooks/bitrix?handle=${handleId}`;

    await this.client.registerWebhook(event, handlerUrl);

    listenerRegistry.set(handleId, callback);
    bindedEvents.set(handleId, event.toUpperCase());
    bindedHandlers.set(handleId, handlerUrl);

    log.info("listener registered", { handle: handleId, event });
    return { id: handleId, adapter: this.name };
  }

  async removeListener(handle: ListenerHandle): Promise<void> {
    const event = bindedEvents.get(handle.id);
    const handlerUrl = bindedHandlers.get(handle.id);
    if (!event || !handlerUrl) return;

    await this.client.unregisterWebhook(event, handlerUrl)
      .catch(e => log.warn("unbind error", { handle: handle.id, error: e.message }));

    listenerRegistry.delete(handle.id);
    bindedEvents.delete(handle.id);
    bindedHandlers.delete(handle.id);
    log.info("listener removed", { handle: handle.id });
  }

  /**
   * Execute a CRM query.
   * Supported entities: "lead", "deal", "contact", "company"
   * Supported metrics: "count", "exists", "sum", "min", "max"
   */
  async executeQuery(query: QueryParams): Promise<number> {
    const { entity, filter, metric, sum_field } = query;

    const entityMethods: Record<string, (f: Record<string, unknown>, s: string[]) => Promise<Record<string, unknown>[]>> = {
      lead:    (f, s) => this.client.getLeads(f, s),
      deal:    (f, s) => this.client.getDeals(f, s),
      contact: (f, s) => this.client.getContacts(f, s),
      company: (f, s) => this.client.getCompanies(f, s),
    };

    const entityFn = entityMethods[entity.toLowerCase()];
    if (!entityFn) throw new Error(`BitrixAdapter.executeQuery: unsupported entity "${entity}"`);

    if (metric === "count" || metric === "exists") {
      const result = await entityFn(filter, ["ID"]);
      const count = Array.isArray(result) ? result.length : 0;
      return metric === "exists" ? (count > 0 ? 1 : 0) : count;
    }

    if (metric === "sum" || metric === "min" || metric === "max") {
      if (!sum_field) throw new Error(`BitrixAdapter.executeQuery: sum_field required for metric=${metric}`);
      const result = await entityFn(filter, [sum_field]);
      if (!Array.isArray(result) || result.length === 0) return 0;
      const values = result
        .map(item => parseFloat(String(item[sum_field] ?? 0)))
        .filter(v => !isNaN(v));
      if (values.length === 0) return 0;
      if (metric === "sum") return values.reduce((acc, v) => acc + v, 0);
      if (metric === "min") return Math.min(...values);
      return Math.max(...values);
    }

    throw new Error(`BitrixAdapter.executeQuery: unsupported metric "${metric}"`);
  }
}

// Singleton for backward compatibility — initialized from env vars
export const bitrixAdapter = new BitrixAdapter(
  new BitrixClient({
    baseUrl: process.env.BITRIX24_WEBHOOK_URL ?? "",
    token: "",
    rateLimitRps: 2,
  }),
);
