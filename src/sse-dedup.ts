import type { Message } from "./redis";

export interface SseMessageEvent {
  id?: string;
  event: string;
  data: string;
}

const DEFAULT_MAX_KEYS = 1000;
const DEFAULT_VILLAGE_ID = "comind.konoha";

export function sseMessageDedupKey(msg: Partial<Message> | null | undefined): string | null {
  if (!msg) return null;
  if (msg.idempotencyKey) return `idempotency:${msg.idempotencyKey}`;
  const logicalParts = [
    msg.from || "",
    msg.to || "",
    msg.type || "",
    msg.channel || "",
    msg.replyTo || "",
    msg.timestamp || "",
    msg.text || "",
    JSON.stringify(msg.attachments || []),
    msg.village_id || DEFAULT_VILLAGE_ID,
  ];
  if (logicalParts.some(Boolean)) return `msg:${logicalParts.join("\x1f")}`;
  return msg.id ? `stream:${msg.id}` : null;
}

export function createSseMessageDeduper(maxKeys = DEFAULT_MAX_KEYS) {
  const seen = new Set<string>();
  const order: string[] = [];

  function remember(key: string): boolean {
    if (seen.has(key)) return false;
    seen.add(key);
    order.push(key);
    while (order.length > maxKeys) {
      const oldest = order.shift();
      if (oldest) seen.delete(oldest);
    }
    return true;
  }

  function rememberMessage(msg: Partial<Message> | null | undefined): boolean {
    const key = sseMessageDedupKey(msg);
    return key ? remember(key) : true;
  }

  function rememberEvent(evt: SseMessageEvent): boolean {
    try {
      const parsed = JSON.parse(evt.data) as Partial<Message>;
      return rememberMessage({ ...parsed, id: parsed.id || evt.id });
    } catch {
      return evt.id ? remember(`stream:${evt.id}`) : true;
    }
  }

  return {
    seed(messages: Partial<Message>[]): void {
      for (const msg of messages) rememberMessage(msg);
    },
    shouldDeliverMessage: rememberMessage,
    shouldDeliverEvent: rememberEvent,
  };
}
