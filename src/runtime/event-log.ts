/**
 * event-log.ts — Runtime event log (Redis Streams).
 * Extracted from runtime.ts (issue #338).
 */
import { redis } from "../redis";

const EVENTS_LOG_KEY = "konoha:events:log";
const EVENTS_LOG_MAX_LEN = 10000;

export interface RuntimeEvent {
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
  const fields: Record<string, string> = { type: event.type, timestamp: event.timestamp };
  if (event.case_id)      fields.case_id = event.case_id;
  if (event.process_id)   fields.process_id = event.process_id;
  if (event.work_item_id) fields.work_item_id = event.work_item_id;
  if (event.element_id)   fields.element_id = event.element_id;
  if (event.label)        fields.label = event.label;
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
    const event: RuntimeEvent = { id: entryId, type: obj.type, timestamp: obj.timestamp };
    if (obj.case_id)      event.case_id = obj.case_id;
    if (obj.process_id)   event.process_id = obj.process_id;
    if (obj.work_item_id) event.work_item_id = obj.work_item_id;
    if (obj.element_id)   event.element_id = obj.element_id;
    if (obj.label)        event.label = obj.label;
    if (!filters.type || event.type === filters.type) result.push(event);
  }
  return result;
}
