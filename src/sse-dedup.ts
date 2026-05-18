import type { Message } from "./redis";

export interface SseMessageEvent {
  id?: string;
  event: string;
  data: string;
}

const DEFAULT_MAX_KEYS = 1000;
const DEFAULT_VILLAGE_ID = "comind.konoha";
const TERMINAL_WORKFLOW_CASE_STATUSES = new Set(["done", "error", "cancelled", "closed", "completed"]);
const CASE_TEXT_PATTERNS = [
  /(?:^|\n|\|\s*)(?:Кейс|Прогон)\s*:\s*([^\s|,\n]+)/i,
  /(?:^|[\s,({])case_id\s*[:=]\s*["']?([A-Za-z0-9._:-]+)["']?/i,
  /(?:^|[\s,({])case\s*=\s*["']?([A-Za-z0-9._:-]+)["']?/i,
];

function candidateCaseId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function extractCaseIdFromJson(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  return candidateCaseId(obj.case_id)
    ?? candidateCaseId(obj.caseId)
    ?? extractCaseIdFromJson(obj.payload)
    ?? extractCaseIdFromJson(obj.context)
    ?? null;
}

export function isTerminalWorkflowCaseStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_WORKFLOW_CASE_STATUSES.has(status.toLowerCase());
}

export function extractWorkflowCaseIdFromMessage(msg: Partial<Message> | null | undefined): string | null {
  if (!msg?.text) return null;

  try {
    const parsed = JSON.parse(msg.text);
    const jsonCaseId = extractCaseIdFromJson(parsed);
    if (jsonCaseId) return jsonCaseId;
  } catch { /* text messages are the common path */ }

  for (const pattern of CASE_TEXT_PATTERNS) {
    const match = msg.text.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

export function sseMessageDedupKey(msg: Partial<Message> | null | undefined): string | null {
  if (!msg) return null;
  const caseId = extractWorkflowCaseIdFromMessage(msg);
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
    caseId || "",
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
