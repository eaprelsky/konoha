import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  enqueueWorkItemDispatchEffect,
  handleWorkItemDispatchEffect,
  processRuntimeEffectOutboxOnceWithHandlers,
  workItemDispatchIdempotencyKey,
  workItemDispatchOutboxHooks,
} from "../src/runtime/workitem-dispatch-outbox";
import {
  getRuntimeEffect,
  runtimeEffectIdFromIdempotencyKey,
} from "../src/runtime-effect-outbox";
import type { DispatchParams, DispatchReceipt } from "../src/dispatcher";
import { makeWorkflowDefinition } from "./factories";
import { createCase, deleteCasesByProcess } from "../src/runtime";
import { createWorkflow } from "../src/workflow-loader";
import { pgDeleteWorkflow } from "../src/storage/pg";

const RUN = `workitem-dispatch-outbox-${Date.now()}`;

const calls: DispatchParams[] = [];
const workflows = new Set<string>();

function params(overrides: Partial<DispatchParams> = {}): DispatchParams {
  const workflow = makeWorkflowDefinition({
    id: `${RUN}:workflow`,
    elements: [
      { id: "start", type: "event", label: "Start" },
      { id: "review", type: "function", label: "Review request", role: "reviewer" },
      { id: "done", type: "event", label: "Done" },
    ],
    flow: [["start", "review"], ["review", "done"]],
  });
  return {
    role: "reviewer",
    label: "Review request",
    work_item_id: `${RUN}:work-item`,
    case_id: `${RUN}:case`,
    process_id: workflow.id,
    element_id: "review",
    docIds: ["dispatch.runbook"],
    def: workflow,
    payload: { priority: "high" },
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  workItemDispatchOutboxHooks.dispatchWorkItem = async (dispatchParams: DispatchParams): Promise<DispatchReceipt> => {
    calls.push(dispatchParams);
    return {
      route: "agent",
      work_item_id: dispatchParams.work_item_id,
      role: dispatchParams.role,
      target_ids: ["reviewer-agent"],
      route_reason: "direct-match",
    };
  };
});

afterAll(async () => {
  await Promise.all([...workflows].map(async id => {
    await deleteCasesByProcess(id).catch(() => {});
    await pgDeleteWorkflow(id).catch(() => {});
  }));
});

describe("work item dispatch outbox", () => {
  test("enqueues durable workitem.dispatch effects with stable idempotency and links", async () => {
    const dispatch = params({ work_item_id: `${RUN}:wi-enqueue`, case_id: `${RUN}:case-enqueue` });
    const first = await enqueueWorkItemDispatchEffect(dispatch, "2026-05-21T20:40:00.000Z");
    const duplicate = await enqueueWorkItemDispatchEffect(dispatch, "2026-05-21T20:40:01.000Z");

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.record.effect_id).toBe(first.record.effect_id);
    expect(first.record).toMatchObject({
      kind: "workitem.dispatch",
      idempotency_key: workItemDispatchIdempotencyKey(dispatch),
      status: "pending",
      links: {
        workflow_id: dispatch.process_id,
        case_id: dispatch.case_id,
        work_item_id: dispatch.work_item_id,
        event_id: dispatch.element_id,
      },
      payload: {
        role: "reviewer",
        label: "Review request",
        work_item_id: dispatch.work_item_id,
        case_id: dispatch.case_id,
        process_id: dispatch.process_id,
        element_id: dispatch.element_id,
        docIds: ["dispatch.runbook"],
        payload: { priority: "high" },
      },
    });

    await expect(getRuntimeEffect(first.record.effect_id)).resolves.toMatchObject({
      effect_id: first.record.effect_id,
      status: "pending",
    });
  });

  test("handler calls dispatcher once and suppresses duplicate notifications after delivery", async () => {
    const dispatch = params({ work_item_id: `${RUN}:wi-dedup`, case_id: `${RUN}:case-dedup` });
    const enqueued = await enqueueWorkItemDispatchEffect(dispatch, "2026-05-21T20:41:00.000Z");

    const first = await handleWorkItemDispatchEffect(enqueued.record);
    const second = await handleWorkItemDispatchEffect(enqueued.record);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      role: "reviewer",
      work_item_id: dispatch.work_item_id,
      case_id: dispatch.case_id,
      element_id: "review",
      payload: { priority: "high" },
    });
    expect(first.receipt?.data).toMatchObject({
      deduplicated: false,
      dispatch: {
        route: "agent",
        target_ids: ["reviewer-agent"],
      },
    });
    expect(second.receipt?.data).toMatchObject({
      deduplicated: true,
      dispatch: {
        route: "agent",
        target_ids: ["reviewer-agent"],
      },
    });
  });

  test("worker retries dispatch failures and dead-letters at bounded attempts", async () => {
    const dispatch = params({ work_item_id: `${RUN}:wi-retry`, case_id: `${RUN}:case-retry` });
    const enqueued = await enqueueWorkItemDispatchEffect(
      dispatch,
      "2000-01-01T00:00:00.000Z",
      { max_attempts: 2, dead_letter_after_attempts: 2, backoff: "fixed", retry_delays_ms: [0] },
    );

    workItemDispatchOutboxHooks.dispatchWorkItem = async () => {
      const error = new Error("dispatcher unavailable") as Error & { code: string; retryable: boolean };
      error.code = "WORKITEM_DISPATCH_UNAVAILABLE";
      error.retryable = true;
      throw error;
    };

    const retry = await processRuntimeEffectOutboxOnceWithHandlers({
      worker_id: "dispatch-worker",
      now: "2000-01-01T00:00:01.000Z",
      batch_size: 100,
    });
    expect(retry).toMatchObject({
      outcome: "retry",
      final_record: {
        effect_id: enqueued.record.effect_id,
        status: "retry",
        attempts: 1,
        error: {
          code: "WORKITEM_DISPATCH_UNAVAILABLE",
          retryable: true,
        },
      },
    });

    const deadLetter = await processRuntimeEffectOutboxOnceWithHandlers({
      worker_id: "dispatch-worker",
      now: "2000-01-01T00:00:02.000Z",
      batch_size: 100,
    });
    expect(deadLetter).toMatchObject({
      outcome: "dead_letter",
      final_record: {
        effect_id: enqueued.record.effect_id,
        status: "dead_letter",
        attempts: 2,
        error: {
          code: "WORKITEM_DISPATCH_UNAVAILABLE",
          retryable: false,
        },
      },
    });
  });

  test("runtime case advancement enqueues dispatch instead of sending immediately", async () => {
    const workflow = makeWorkflowDefinition({
      id: `${RUN}:runtime-workflow`,
      elements: [
        { id: "start", type: "event", label: "Start" },
        { id: "review", type: "function", label: "Review request", role: "reviewer" },
        { id: "done", type: "event", label: "Done" },
      ],
      flow: [["start", "review"], ["review", "done"]],
    });
    workflows.add(workflow.id);
    const created = await createWorkflow(workflow, { lifecycleState: "executable" });
    expect(created.errors).toHaveLength(0);

    const kase = await createCase(workflow.id, "dispatch outbox case", { priority: "high" });
    const workItemId = kase.history.find(entry => entry.element_id === "review")?.work_item_id;
    expect(workItemId).toBeDefined();
    expect(calls).toHaveLength(0);

    const idempotencyKey = `workitem.dispatch:${kase.case_id}:${workItemId}`;
    const dispatchEffect = await getRuntimeEffect(runtimeEffectIdFromIdempotencyKey(idempotencyKey));
    expect(dispatchEffect).toMatchObject({
      kind: "workitem.dispatch",
      idempotency_key: idempotencyKey,
      links: {
        workflow_id: workflow.id,
        case_id: kase.case_id,
        work_item_id: workItemId,
      },
      payload: {
        role: "reviewer",
        label: "Review request",
        case_id: kase.case_id,
        work_item_id: workItemId,
        payload: { priority: "high" },
      },
    });
  });
});
