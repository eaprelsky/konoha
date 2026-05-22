import { createHash } from "crypto";
import { sendConnectorMessage } from "../messenger-outbound";
import { redis } from "../redis";
import {
  enqueueRuntimeEffect,
  processRuntimeEffectOutboxOnce,
  type RuntimeEffectClaimOptions,
  type RuntimeEffectEnqueueResult,
  type RuntimeEffectHandlerResult,
  type RuntimeEffectRecord,
  type RuntimeEffectRetryPolicy,
} from "../runtime-effect-outbox";

const CONNECTOR_SEND_DELIVERED_PREFIX = "connector:send-message:delivered:";
const CONNECTOR_SEND_DELIVERED_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface ConnectorSendMessageParams {
  connector_id: string;
  endpoint_id: string;
  chat_ref: string;
  text: string;
  reply_to?: string;
  parse_mode?: string;
  dry_run?: boolean;
  metadata?: Record<string, unknown>;
  case_id?: string;
  work_item_id?: string;
  action_trace_id?: string;
}

export const connectorSendOutboxHooks = {
  sendConnectorMessage,
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
  return `{${entries.join(",")}}`;
}

export function connectorSendMessageIdempotencyKey(params: ConnectorSendMessageParams): string {
  const source = stableJson({
    connector_id: params.connector_id,
    endpoint_id: params.endpoint_id,
    chat_ref: params.chat_ref,
    text: params.text,
    reply_to: params.reply_to,
    parse_mode: params.parse_mode,
    dry_run: params.dry_run === true,
    metadata: params.metadata ?? {},
    case_id: params.case_id,
    work_item_id: params.work_item_id,
    action_trace_id: params.action_trace_id,
  });
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 24);
  return `connector.send_message:${params.connector_id}:${params.endpoint_id}:${hash}`;
}

export async function enqueueConnectorSendMessageEffect(
  params: ConnectorSendMessageParams,
  now = new Date().toISOString(),
  retryPolicy?: Partial<RuntimeEffectRetryPolicy>,
): Promise<RuntimeEffectEnqueueResult> {
  return enqueueRuntimeEffect({
    kind: "connector.send_message",
    idempotency_key: connectorSendMessageIdempotencyKey(params),
    payload: {
      connector_id: params.connector_id,
      endpoint_id: params.endpoint_id,
      chat_ref: params.chat_ref,
      text: params.text,
      reply_to: params.reply_to,
      parse_mode: params.parse_mode,
      dry_run: params.dry_run === true,
      metadata: params.metadata,
    },
    links: {
      connector_id: params.connector_id,
      ...(params.case_id ? { case_id: params.case_id } : {}),
      ...(params.work_item_id ? { work_item_id: params.work_item_id } : {}),
      ...(params.action_trace_id ? { action_trace_id: params.action_trace_id } : {}),
    },
    ...(retryPolicy ? { retry_policy: retryPolicy } : {}),
  }, now);
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw Object.assign(new Error(message), { code, retryable: false, details });
}

function stringField(payload: Record<string, unknown>, key: keyof ConnectorSendMessageParams): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    fail("CONNECTOR_SEND_PAYLOAD_INVALID", `connector.send_message payload.${String(key)} is required`, { key });
  }
  return value;
}

function connectorParamsFromEffect(record: RuntimeEffectRecord): ConnectorSendMessageParams {
  const payload = record.payload;
  const connectorId = stringField(payload, "connector_id");
  if (record.links.connector_id && record.links.connector_id !== connectorId) {
    fail("CONNECTOR_SEND_LINK_MISMATCH", "connector.send_message connector_id does not match effect links", {
      link_connector_id: record.links.connector_id,
      payload_connector_id: connectorId,
    });
  }
  const metadata = payload.metadata;
  return {
    connector_id: connectorId,
    endpoint_id: stringField(payload, "endpoint_id"),
    chat_ref: stringField(payload, "chat_ref"),
    text: stringField(payload, "text"),
    reply_to: typeof payload.reply_to === "string" ? payload.reply_to : undefined,
    parse_mode: typeof payload.parse_mode === "string" ? payload.parse_mode : undefined,
    dry_run: payload.dry_run === true,
    metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata as Record<string, unknown>
      : undefined,
  };
}

function deliveredKey(record: RuntimeEffectRecord): string {
  return `${CONNECTOR_SEND_DELIVERED_PREFIX}${record.effect_id}`;
}

async function readDeliveredReceipt(record: RuntimeEffectRecord): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(deliveredKey(record));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeDeliveredReceipt(record: RuntimeEffectRecord, receipt: Record<string, unknown>): Promise<void> {
  await redis.set(deliveredKey(record), JSON.stringify(receipt), "EX", CONNECTOR_SEND_DELIVERED_TTL_SECONDS);
}

export async function handleConnectorSendMessageEffect(record: RuntimeEffectRecord): Promise<RuntimeEffectHandlerResult> {
  if (record.kind !== "connector.send_message") {
    fail("RUNTIME_EFFECT_KIND_UNSUPPORTED", `Unsupported runtime effect kind for connector sender: ${record.kind}`, { kind: record.kind });
  }
  const params = connectorParamsFromEffect(record);
  const existing = await readDeliveredReceipt(record);
  if (existing) {
    return {
      receipt: {
        data: {
          connector_id: params.connector_id,
          endpoint_id: params.endpoint_id,
          deduplicated: true,
          result: existing,
        },
      },
    };
  }
  const result = await connectorSendOutboxHooks.sendConnectorMessage(params);
  const receipt = result as unknown as Record<string, unknown>;
  await writeDeliveredReceipt(record, receipt);
  return {
    receipt: {
      data: {
        connector_id: params.connector_id,
        endpoint_id: params.endpoint_id,
        deduplicated: false,
        result: receipt,
      },
    },
  };
}

export function processRuntimeEffectOutboxOnceWithConnectorHandlers(options: RuntimeEffectClaimOptions) {
  return processRuntimeEffectOutboxOnce({ ...options, kinds: ["connector.send_message"] }, handleConnectorSendMessageEffect);
}
