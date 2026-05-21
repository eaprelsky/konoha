import { getAdapter } from "../adapters";
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
import type { SystemBinding, WorkflowDefinition } from "../workflow-loader";

const ADAPTER_INVOKE_DELIVERED_PREFIX = "adapter:invoke:delivered:";
const ADAPTER_INVOKE_DELIVERED_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface AdapterInvokeParams {
  connector: string;
  operation: string;
  input: Record<string, unknown>;
  case_id: string;
  process_id: string;
  element_id: string;
  work_item_id: string;
  binding_id?: string;
  def?: WorkflowDefinition;
}

export const adapterInvokeOutboxHooks = {
  getAdapter,
};

export function adapterInvokeBindingKey(binding: SystemBinding, index: number): string {
  return binding.binding_id?.trim() || `${binding.connector}:${binding.operation || "default"}:${index}`;
}

export function adapterInvokeIdempotencyKey(params: Pick<AdapterInvokeParams, "case_id" | "work_item_id" | "connector" | "operation"> & { binding_key: string }): string {
  return `adapter.invoke:${params.case_id}:${params.work_item_id}:${params.binding_key}:${params.connector}:${params.operation}`;
}

export async function enqueueAdapterInvokeEffect(
  params: AdapterInvokeParams & { binding_key: string },
  now = new Date().toISOString(),
  retryPolicy?: Partial<RuntimeEffectRetryPolicy>,
): Promise<RuntimeEffectEnqueueResult> {
  return enqueueRuntimeEffect({
    kind: "adapter.invoke",
    idempotency_key: adapterInvokeIdempotencyKey(params),
    payload: {
      connector: params.connector,
      operation: params.operation,
      binding_id: params.binding_id,
      binding_key: params.binding_key,
      input: params.input,
      case_id: params.case_id,
      process_id: params.process_id,
      element_id: params.element_id,
      work_item_id: params.work_item_id,
    },
    links: {
      workflow_id: params.def?.id ?? params.process_id,
      case_id: params.case_id,
      work_item_id: params.work_item_id,
      event_id: params.element_id,
      adapter_id: params.connector,
    },
    ...(retryPolicy ? { retry_policy: retryPolicy } : {}),
  }, now);
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw Object.assign(new Error(message), { code, retryable: false, details });
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    fail("ADAPTER_INVOKE_PAYLOAD_INVALID", `adapter.invoke payload.${key} is required`, { key });
  }
  return value;
}

function invokeParamsFromEffect(record: RuntimeEffectRecord): AdapterInvokeParams {
  const payload = record.payload;
  const connector = stringField(payload, "connector");
  const operation = stringField(payload, "operation");
  const caseId = stringField(payload, "case_id");
  const workItemId = stringField(payload, "work_item_id");
  if (record.links.case_id && record.links.case_id !== caseId) {
    fail("ADAPTER_INVOKE_LINK_MISMATCH", "adapter.invoke case_id does not match effect links", { link_case_id: record.links.case_id, payload_case_id: caseId });
  }
  if (record.links.work_item_id && record.links.work_item_id !== workItemId) {
    fail("ADAPTER_INVOKE_LINK_MISMATCH", "adapter.invoke work_item_id does not match effect links", { link_work_item_id: record.links.work_item_id, payload_work_item_id: workItemId });
  }
  if (record.links.adapter_id && record.links.adapter_id !== connector) {
    fail("ADAPTER_INVOKE_LINK_MISMATCH", "adapter.invoke connector does not match effect links", { link_adapter_id: record.links.adapter_id, payload_connector: connector });
  }
  const input = payload.input;
  return {
    connector,
    operation,
    input: input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {},
    case_id: caseId,
    process_id: stringField(payload, "process_id"),
    element_id: stringField(payload, "element_id"),
    work_item_id: workItemId,
    binding_id: typeof payload.binding_id === "string" ? payload.binding_id : undefined,
  };
}

function deliveredKey(record: RuntimeEffectRecord): string {
  return `${ADAPTER_INVOKE_DELIVERED_PREFIX}${record.effect_id}`;
}

async function readDeliveredOutput(record: RuntimeEffectRecord): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(deliveredKey(record));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeDeliveredOutput(record: RuntimeEffectRecord, output: Record<string, unknown>): Promise<void> {
  await redis.set(deliveredKey(record), JSON.stringify(output), "EX", ADAPTER_INVOKE_DELIVERED_TTL_SECONDS);
}

export async function handleAdapterInvokeEffect(record: RuntimeEffectRecord): Promise<RuntimeEffectHandlerResult> {
  if (record.kind !== "adapter.invoke") {
    fail("RUNTIME_EFFECT_KIND_UNSUPPORTED", `Unsupported runtime effect kind for adapter invoker: ${record.kind}`, { kind: record.kind });
  }
  const params = invokeParamsFromEffect(record);
  const existing = await readDeliveredOutput(record);
  if (existing) {
    return {
      receipt: {
        data: {
          connector: params.connector,
          operation: params.operation,
          binding_id: params.binding_id,
          deduplicated: true,
          output: existing,
        },
      },
    };
  }
  const adapter = adapterInvokeOutboxHooks.getAdapter(params.connector);
  if (!adapter) {
    fail("ADAPTER_MISSING", `Adapter "${params.connector}" is not registered`, { connector: params.connector, operation: params.operation });
  }
  const output = await adapter.execute(params.operation, params.input);
  await writeDeliveredOutput(record, output);
  return {
    receipt: {
      data: {
        connector: params.connector,
        operation: params.operation,
        binding_id: params.binding_id,
        deduplicated: false,
        output,
      },
    },
  };
}

export function processRuntimeEffectOutboxOnceWithAdapterHandlers(options: RuntimeEffectClaimOptions) {
  return processRuntimeEffectOutboxOnce(options, handleAdapterInvokeEffect);
}
