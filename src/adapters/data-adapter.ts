/**
 * data-adapter.ts — DataAdapter interface for Event Manager.
 *
 * Each adapter bridges an external data source to the Event Manager:
 * - EventListener: subscribe to events (webhooks, polling, long-poll)
 * - DataQuery: fetch a numeric metric for condition triggers
 *
 * Spec: event-system-requirements-v2.md, section 5
 */

export interface ListenerHandle {
  id: string;       // unique handle ID (UUID)
  adapter: string;  // adapter name: "bitrix" | "telegram" | "tracker"
}

export interface QueryParams {
  entity: string;                       // e.g. "lead", "deal", "issue"
  filter: Record<string, unknown>;      // source-specific filter fields
  metric: "count" | "sum" | "min" | "max" | "exists";
  sum_field?: string;                   // field to sum (for metric=sum)
}

export interface DataAdapter {
  readonly name: string;

  /**
   * Register a listener for incoming events matching `filter`.
   * `callback` is called with the raw event payload on each match.
   * Returns a handle used to remove the listener later.
   */
  setupListener(
    filter: Record<string, unknown>,
    callback: (payload: unknown) => void,
  ): Promise<ListenerHandle>;

  /**
   * Remove a previously registered listener.
   */
  removeListener(handle: ListenerHandle): Promise<void>;

  /**
   * Execute a data query and return a numeric result.
   * Used for condition triggers.
   */
  executeQuery(query: QueryParams): Promise<number>;
}

// Shared in-memory registry for webhook dispatch (used by adapter implementations)
// Maps handleId → callback function, populated by setupListener
export const listenerRegistry = new Map<string, (payload: unknown) => void>();
