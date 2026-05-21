import { dispatchWorkItem, type DispatchParams, type DispatchReceipt } from "../dispatcher";
import { redis } from "../redis";
import { handleAdapterInvokeEffect } from "./adapter-outbox";
import {
  enqueueRuntimeEffect,
  processRuntimeEffectOutboxOnce,
  type RuntimeEffectClaimOptions,
  type RuntimeEffectEnqueueResult,
  type RuntimeEffectHandlerResult,
  type RuntimeEffectRetryPolicy,
  type RuntimeEffectRecord,
} from "../runtime-effect-outbox";
import type { WorkflowDefinition } from "../workflow-loader";

const WORKITEM_DISPATCH_DELIVERED_PREFIX = "workitem:dispatch:delivered:";
const WORKITEM_DISPATCH_DELIVERED_TTL_SECONDS = 60 * 60 * 24 * 30;

export const workItemDispatchOutboxHooks = {
  dispatchWorkItem,
};

export function workItemDispatchIdempotencyKey(params: Pick<DispatchParams, "case_id" | "work_item_id">): string {
  return `workitem.dispatch:${params.case_id}:${params.work_item_id}`;
}

export async function enqueueWorkItemDispatchEffect(
  params: DispatchParams,
  now = new Date().toISOString(),
  retryPolicy?: Partial<RuntimeEffectRetryPolicy>,
): Promise<RuntimeEffectEnqueueResult> {
  return enqueueRuntimeEffect({
    kind: "workitem.dispatch",
    idempotency_key: workItemDispatchIdempotencyKey(params),
    payload: {
      role: params.role,
      label: params.label,
      work_item_id: params.work_item_id,
      case_id: params.case_id,
      process_id: params.process_id,
      element_id: params.element_id,
      docIds: params.docIds,
      ...(params.def ? { def: params.def } : {}),
      ...(params.payload ? { payload: params.payload } : {}),
    },
    links: {
      workflow_id: params.def?.id ?? params.process_id,
      case_id: params.case_id,
      work_item_id: params.work_item_id,
      event_id: params.element_id,
    },
    ...(retryPolicy ? { retry_policy: retryPolicy } : {}),
  }, now);
}

function assertString(payload: Record<string, unknown>, key: keyof DispatchParams): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`workitem.dispatch payload.${String(key)} is required`), {
      code: "WORKITEM_DISPATCH_PAYLOAD_INVALID",
      retryable: false,
      details: { key },
    });
  }
  return value;
}

function dispatchParamsFromEffect(record: RuntimeEffectRecord): DispatchParams {
  const payload = record.payload;
  const docIds = payload.docIds;
  if (docIds !== undefined && (!Array.isArray(docIds) || docIds.some(item => typeof item !== "string"))) {
    throw Object.assign(new Error("workitem.dispatch payload.docIds must be a string array"), {
      code: "WORKITEM_DISPATCH_PAYLOAD_INVALID",
      retryable: false,
      details: { key: "docIds" },
    });
  }
  const normalizedDocIds = Array.isArray(docIds) ? docIds as string[] : [];
  const caseId = assertString(payload, "case_id");
  const workItemId = assertString(payload, "work_item_id");
  if (record.links.case_id && record.links.case_id !== caseId) {
    throw Object.assign(new Error("workitem.dispatch case_id does not match effect links"), {
      code: "WORKITEM_DISPATCH_LINK_MISMATCH",
      retryable: false,
      details: { link_case_id: record.links.case_id, payload_case_id: caseId },
    });
  }
  if (record.links.work_item_id && record.links.work_item_id !== workItemId) {
    throw Object.assign(new Error("workitem.dispatch work_item_id does not match effect links"), {
      code: "WORKITEM_DISPATCH_LINK_MISMATCH",
      retryable: false,
      details: { link_work_item_id: record.links.work_item_id, payload_work_item_id: workItemId },
    });
  }
  return {
    role: assertString(payload, "role"),
    label: assertString(payload, "label"),
    work_item_id: workItemId,
    case_id: caseId,
    process_id: assertString(payload, "process_id"),
    element_id: assertString(payload, "element_id"),
    docIds: normalizedDocIds,
    def: payload.def as WorkflowDefinition | undefined,
    payload: payload.payload && typeof payload.payload === "object" && !Array.isArray(payload.payload)
      ? payload.payload as Record<string, unknown>
      : undefined,
  };
}

function deliveredKey(record: RuntimeEffectRecord): string {
  return `${WORKITEM_DISPATCH_DELIVERED_PREFIX}${record.effect_id}`;
}

async function readDeliveredReceipt(record: RuntimeEffectRecord): Promise<DispatchReceipt | null> {
  const raw = await redis.get(deliveredKey(record));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DispatchReceipt;
  } catch {
    return null;
  }
}

async function writeDeliveredReceipt(record: RuntimeEffectRecord, receipt: DispatchReceipt): Promise<void> {
  await redis.set(deliveredKey(record), JSON.stringify(receipt), "EX", WORKITEM_DISPATCH_DELIVERED_TTL_SECONDS);
}

export async function handleWorkItemDispatchEffect(record: RuntimeEffectRecord): Promise<RuntimeEffectHandlerResult> {
  if (record.kind !== "workitem.dispatch") {
    throw Object.assign(new Error(`Unsupported runtime effect kind for work item dispatcher: ${record.kind}`), {
      code: "RUNTIME_EFFECT_KIND_UNSUPPORTED",
      retryable: false,
      details: { kind: record.kind },
    });
  }
  const existing = await readDeliveredReceipt(record);
  if (existing) {
    return {
      receipt: {
        data: {
          deduplicated: true,
          dispatch: existing as unknown as Record<string, unknown>,
        },
      },
    };
  }
  const receipt = await workItemDispatchOutboxHooks.dispatchWorkItem(dispatchParamsFromEffect(record));
  await writeDeliveredReceipt(record, receipt);
  return {
    receipt: {
      data: {
        deduplicated: false,
        dispatch: receipt as unknown as Record<string, unknown>,
      },
    },
  };
}

export async function handleRuntimeEffect(record: RuntimeEffectRecord): Promise<RuntimeEffectHandlerResult> {
  switch (record.kind) {
    case "adapter.invoke":
      return handleAdapterInvokeEffect(record);
    case "workitem.dispatch":
      return handleWorkItemDispatchEffect(record);
    default:
      throw Object.assign(new Error(`Unsupported runtime effect kind: ${record.kind}`), {
        code: "RUNTIME_EFFECT_KIND_UNSUPPORTED",
        retryable: false,
        details: { kind: record.kind },
      });
  }
}

export function processRuntimeEffectOutboxOnceWithHandlers(options: RuntimeEffectClaimOptions) {
  return processRuntimeEffectOutboxOnce(options, handleRuntimeEffect);
}
