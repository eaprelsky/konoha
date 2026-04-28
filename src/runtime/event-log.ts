/**
 * event-log.ts — Runtime event log (Redis Streams).
 * Extracted from runtime.ts (issue #338).
 */
import { redis } from "../redis";

const EVENTS_LOG_KEY = "konoha:events:log";
const EVENTS_LOG_MAX_LEN = 10000;

export interface RuntimeEvent {
  [key: string]: unknown;
  id?: string;
  type: string;
  case_id?: string;
  process_id?: string;
  work_item_id?: string;
  element_id?: string;
  label?: string;
  timestamp: string;
}

export async function emitEvent(event: Omit<RuntimeEvent, "id">): Promise<void> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === "id" || value === undefined || value === null) continue;
    fields[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  await redis.xadd(EVENTS_LOG_KEY, "MAXLEN", "~", EVENTS_LOG_MAX_LEN, "*", ...Object.entries(fields).flat());
}

export async function listEvents(filters: {
  type?: string;
  after?: string;
  before?: string;
  limit?: number;
}): Promise<RuntimeEvent[]> {
  const limit = Math.min(filters.limit ?? 100, 1000);

  function toStreamId(s: string): string {
    if (/^\d+-\d+$/.test(s) || /^\d+$/.test(s)) return s;
    const ms = new Date(s).getTime();
    return isNaN(ms) ? "-" : String(ms);
  }

  const start = filters.after ? toStreamId(filters.after) : "-";
  const end   = filters.before ? toStreamId(filters.before) : "+";

  const entries = await redis.xrange(EVENTS_LOG_KEY, start, end, "COUNT", limit) as [string, string[]][];
  const result: RuntimeEvent[] = [];
  for (const [entryId, fields] of entries) {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
    const event: RuntimeEvent = { ...obj, id: entryId, type: obj.type, timestamp: obj.timestamp };
    if (!filters.type || event.type === filters.type) result.push(event);
  }
  return result;
}
