/**
 * tracker.ts — Yandex Tracker DataAdapter implementation.
 *
 * EventListener: periodic polling (no push webhooks available).
 *   Tracks last seen issue updatedAt per handle.
 *   filter fields: queue, status, type, priority, assignee.
 * DataQuery: issue search with filters, returns count (or exists/min/max/sum).
 *
 * Config: TRACKER_TOKEN + TRACKER_CLOUD_ORG_ID env vars.
 */

import { randomUUID } from "crypto";
import type { DataAdapter, ListenerHandle, QueryParams } from "./data-adapter";
import { listenerRegistry } from "./data-adapter";
import { TrackerClient } from "../clients/tracker";

// Default poll interval for event listeners (ms)
const DEFAULT_POLL_MS = 30_000;

export class TrackerAdapter implements DataAdapter {
  readonly name = "tracker";
  private client: TrackerClient;
  private pollingTimers = new Map<string, ReturnType<typeof setInterval>>();
  private lastSeen = new Map<string, string>(); // handleId → ISO timestamp

  constructor(client: TrackerClient) {
    this.client = client;
  }

  /**
   * Register a polling listener for Tracker issues.
   * filter: { queue?, status?, type?, priority?, assignee?, poll_interval_ms? }
   * poll_interval_ms defaults to 30s.
   */
  async setupListener(
    filter: Record<string, unknown>,
    callback: (payload: unknown) => void,
  ): Promise<ListenerHandle> {
    const handleId = randomUUID();
    const pollMs = typeof filter.poll_interval_ms === "number"
      ? filter.poll_interval_ms
      : DEFAULT_POLL_MS;

    // Strip internal fields from Tracker query filter
    const queryFilter = { ...filter };
    delete queryFilter.poll_interval_ms;

    listenerRegistry.set(handleId, callback);
    this.lastSeen.set(handleId, new Date().toISOString());

    const timer = setInterval(async () => {
      try {
        const since = this.lastSeen.get(handleId) ?? new Date().toISOString();
        const issues = await this.client.searchIssues({
          ...queryFilter,
          updatedAt: { from: since },
        });

        if (issues.length > 0) {
          const latest = issues.map(i => i.updatedAt).sort().pop()!;
          this.lastSeen.set(handleId, latest);

          const cb = listenerRegistry.get(handleId);
          if (cb) {
            for (const issue of issues) {
              try { cb(issue); } catch (e: any) {
                console.error(`[tracker] callback error handle=${handleId}: ${e.message}`);
              }
            }
          }
        }
      } catch (e: any) {
        console.error(`[tracker] poll error handle=${handleId}: ${e.message}`);
      }
    }, pollMs);

    this.pollingTimers.set(handleId, timer);
    console.log(`[tracker] listener registered handle=${handleId} pollMs=${pollMs} filter=${JSON.stringify(queryFilter)}`);
    return { id: handleId, adapter: this.name };
  }

  async removeListener(handle: ListenerHandle): Promise<void> {
    const timer = this.pollingTimers.get(handle.id);
    if (timer) {
      clearInterval(timer);
      this.pollingTimers.delete(handle.id);
    }
    listenerRegistry.delete(handle.id);
    this.lastSeen.delete(handle.id);
    console.log(`[tracker] listener removed handle=${handle.id}`);
  }

  /**
   * Execute a data query against Tracker issues.
   * query.entity: "issue" (only supported entity)
   * Supported metrics: "count", "exists", "sum", "min", "max"
   */
  async executeQuery(query: QueryParams): Promise<number> {
    const { entity, filter, metric, sum_field } = query;

    if (entity !== "issue" && entity !== "issues") {
      throw new Error(`TrackerAdapter.executeQuery: unsupported entity "${entity}"`);
    }

    const issues = await this.client.searchIssues(filter);

    switch (metric) {
      case "count": return issues.length;
      case "exists": return issues.length > 0 ? 1 : 0;
      case "sum": {
        if (!sum_field) throw new Error("TrackerAdapter.executeQuery: sum_field required for metric=sum");
        return issues.reduce((acc, i) => {
          const v = parseFloat(String(i[sum_field] ?? 0));
          return acc + (isNaN(v) ? 0 : v);
        }, 0);
      }
      case "min": {
        if (!sum_field) throw new Error("TrackerAdapter.executeQuery: sum_field required for metric=min");
        const vals = issues.map(i => parseFloat(String(i[sum_field] ?? 0))).filter(v => !isNaN(v));
        return vals.length === 0 ? 0 : Math.min(...vals);
      }
      case "max": {
        if (!sum_field) throw new Error("TrackerAdapter.executeQuery: sum_field required for metric=max");
        const vals = issues.map(i => parseFloat(String(i[sum_field] ?? 0))).filter(v => !isNaN(v));
        return vals.length === 0 ? 0 : Math.max(...vals);
      }
      default:
        throw new Error(`TrackerAdapter.executeQuery: unsupported metric "${metric}"`);
    }
  }
}

// Singleton for backward compatibility — initialized from env vars
export const trackerAdapter = new TrackerAdapter(
  new TrackerClient({
    baseUrl: "https://api.tracker.yandex.net/v2",
    token: process.env.TRACKER_TOKEN ?? "",
    orgId: process.env.TRACKER_CLOUD_ORG_ID ?? "",
  }),
);
