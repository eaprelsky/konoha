import { processEvent, type Case } from "./runtime";

export type MessengerEventKind = "message" | "reaction";
export type MessengerProvider = "telegram" | "whatsapp" | "email" | "custom";
export type MessengerChatType = "direct" | "group" | "channel" | "unknown";

export interface NormalizedMessengerEvent {
  provider: MessengerProvider;
  connector_id: string;
  endpoint_id: string;
  event_kind: MessengerEventKind;
  chat_ref: string;
  chat_type: MessengerChatType;
  message_id?: string;
  text?: string;
  sender_ref?: string;
  sender_name?: string;
  timestamp?: string;
  raw: Record<string, unknown>;
}

export interface WorkflowEventEnvelope {
  type: string;
  source: string;
  payload: Record<string, unknown>;
}

export function normalizeTelegramStreamEvent(input: {
  connector_id?: string;
  endpoint_id: string;
  stream: string;
  stream_id: string;
  fields: Record<string, unknown>;
}): NormalizedMessengerEvent {
  const fields = input.fields;
  const chatId = fields.chat_id ?? fields.chat;
  const hasReaction = fields.new_reaction !== undefined || fields.old_reaction !== undefined;
  return {
    provider: "telegram",
    connector_id: input.connector_id ?? "telegram-main",
    endpoint_id: input.endpoint_id,
    event_kind: hasReaction ? "reaction" : "message",
    chat_ref: chatId === undefined ? "*" : String(chatId),
    chat_type: chatTypeFromTelegram(fields),
    message_id: stringField(fields.msg_id ?? fields.message_id),
    text: stringField(fields.text ?? fields.message),
    sender_ref: stringField(fields.sender_id ?? fields.from_id ?? fields.user_id),
    sender_name: stringField(fields.sender_name ?? fields.from_name ?? fields.username),
    timestamp: stringField(fields.ts ?? fields.timestamp),
    raw: {
      ...fields,
      telegram_stream: input.stream,
      telegram_stream_id: input.stream_id,
    },
  };
}

export function messengerEventToWorkflowEvent(event: NormalizedMessengerEvent): WorkflowEventEnvelope {
  const type = `${event.provider}.${event.event_kind}.received`;
  return {
    type,
    source: event.provider,
    payload: {
      ...event.raw,
      connector_id: event.connector_id,
      endpoint_id: event.endpoint_id,
      provider: event.provider,
      event_kind: event.event_kind,
      chat_ref: event.chat_ref,
      chat_type: event.chat_type,
      message_id: event.message_id,
      text: event.text,
      sender_ref: event.sender_ref,
      sender_name: event.sender_name,
      timestamp: event.timestamp,
    },
  };
}

export async function routeMessengerEventToWorkflows(event: NormalizedMessengerEvent): Promise<Case[]> {
  const workflowEvent = messengerEventToWorkflowEvent(event);
  return processEvent(workflowEvent.type, workflowEvent.source, workflowEvent.payload);
}

function stringField(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function chatTypeFromTelegram(fields: Record<string, unknown>): MessengerChatType {
  const raw = stringField(fields.chat_type ?? fields.type);
  if (raw === "private" || raw === "direct") return "direct";
  if (raw === "group" || raw === "supergroup") return "group";
  if (raw === "channel") return "channel";
  return "unknown";
}
