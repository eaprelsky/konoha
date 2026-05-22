import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { registerAdapter, type Adapter } from "../src/adapters";
import {
  adapterInvokeIdempotencyKey,
  enqueueAdapterInvokeEffect,
  handleAdapterInvokeEffect,
  processRuntimeEffectOutboxOnceWithAdapterHandlers,
} from "../src/runtime/adapter-outbox";
import {
  getRuntimeEffect,
  runtimeEffectIdFromIdempotencyKey,
} from "../src/runtime-effect-outbox";
import { createCase, deleteCasesByProcess } from "../src/runtime";
import { createRole, deleteRole } from "../src/runtime/roles";
import { createWorkflow, validateWorkflowReadiness, type WorkflowDefinition } from "../src/workflow-loader";
import { completeWorkItem } from "../src/runtime/work-items";
import { pgDeleteWorkflow } from "../src/storage/pg";
import { makeWorkflowDefinition } from "./factories";

const RUN = `adapter-outbox-${Date.now()}`;
const REVIEWER_ROLE = `${RUN}:reviewer`;
const workflows = new Set<string>();
const calls: Array<{ adapter: string; action: string; input: Record<string, unknown> }> = [];

function adapter(name: string, fail = false): Adapter {
  return {
    async execute(action, input) {
      calls.push({ adapter: name, action, input });
      if (fail) {
        const error = new Error("adapter unavailable") as Error & { code: string; retryable: boolean };
        error.code = "ADAPTER_UNAVAILABLE";
        error.retryable = true;
        throw error;
      }
      return { adapter: name, action, observed: input.observed ?? true };
    },
    async healthcheck() {
      return true;
    },
  };
}

beforeEach(() => {
  calls.length = 0;
});

beforeAll(async () => {
  await createRole({
    role_id: REVIEWER_ROLE,
    name: "Adapter outbox reviewer",
    assignees: [],
    strategy: "manual",
    required_capabilities: [],
  });
});

afterAll(async () => {
  await Promise.all([...workflows].map(async id => {
    await deleteCasesByProcess(id).catch(() => {});
    await pgDeleteWorkflow(id).catch(() => {});
  }));
  await deleteRole(REVIEWER_ROLE).catch(() => {});
});

describe("adapter invoke outbox", () => {
  test("enqueues and handles adapter.invoke with stable idempotency and receipt", async () => {
    const adapterId = `${RUN}:adapter-success`;
    registerAdapter(adapterId, adapter(adapterId));
    const params = {
      connector: adapterId,
      operation: "notify",
      binding_id: "notify-customer",
      binding_key: "notify-customer",
      input: { observed: "payload" },
      case_id: `${RUN}:case-success`,
      process_id: `${RUN}:workflow-success`,
      element_id: "notify",
      work_item_id: `${RUN}:wi-success`,
    };
    const first = await enqueueAdapterInvokeEffect(params, "2026-05-22T00:01:00.000Z");
    const duplicate = await enqueueAdapterInvokeEffect(params, "2026-05-22T00:01:01.000Z");

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(first.record).toMatchObject({
      kind: "adapter.invoke",
      idempotency_key: adapterInvokeIdempotencyKey(params),
      status: "pending",
      links: {
        case_id: params.case_id,
        work_item_id: params.work_item_id,
        event_id: "notify",
        adapter_id: adapterId,
      },
      payload: {
        connector: adapterId,
        operation: "notify",
        binding_id: "notify-customer",
        input: { observed: "payload" },
      },
    });

    const handled = await handleAdapterInvokeEffect(first.record);
    const deduped = await handleAdapterInvokeEffect(first.record);
    expect(calls).toHaveLength(1);
    expect(handled.receipt?.data).toMatchObject({
      connector: adapterId,
      operation: "notify",
      binding_id: "notify-customer",
      deduplicated: false,
      output: { adapter: adapterId, action: "notify", observed: "payload" },
    });
    expect(deduped.receipt?.data).toMatchObject({
      deduplicated: true,
      output: { adapter: adapterId, action: "notify", observed: "payload" },
    });
  });

  test("adapter worker retries failures and dead-letters at bounded attempts", async () => {
    const adapterId = `${RUN}:adapter-retry`;
    registerAdapter(adapterId, adapter(adapterId, true));
    const enqueued = await enqueueAdapterInvokeEffect({
      connector: adapterId,
      operation: "notify",
      binding_key: "notify",
      input: { observed: "retry" },
      case_id: `${RUN}:case-retry`,
      process_id: `${RUN}:workflow-retry`,
      element_id: "notify",
      work_item_id: `${RUN}:wi-retry`,
    }, "2000-01-01T00:00:00.000Z", { max_attempts: 2, dead_letter_after_attempts: 2, backoff: "fixed", retry_delays_ms: [0] });

    const retry = await processRuntimeEffectOutboxOnceWithAdapterHandlers({
      worker_id: "adapter-worker",
      now: "2000-01-01T00:00:01.000Z",
      batch_size: 100,
    });
    expect(retry).toMatchObject({
      outcome: "retry",
      final_record: {
        effect_id: enqueued.record.effect_id,
        status: "retry",
        attempts: 1,
        error: { code: "ADAPTER_UNAVAILABLE", retryable: true },
      },
    });

    const deadLetter = await processRuntimeEffectOutboxOnceWithAdapterHandlers({
      worker_id: "adapter-worker",
      now: "2000-01-01T00:00:02.000Z",
      batch_size: 100,
    });
    expect(deadLetter).toMatchObject({
      outcome: "dead_letter",
      final_record: {
        effect_id: enqueued.record.effect_id,
        status: "dead_letter",
        attempts: 2,
        error: { code: "ADAPTER_UNAVAILABLE", retryable: false },
      },
    });
  });

  test("runtime enqueues safe async adapter bindings without executing them inline", async () => {
    const adapterId = `${RUN}:adapter-async-runtime`;
    registerAdapter(adapterId, adapter(adapterId));
    const workflow = makeWorkflowDefinition({
      id: `${RUN}:workflow-async-runtime`,
      elements: [
        { id: "start", type: "event", label: "Start" },
        {
          id: "review",
          type: "function",
          label: "Review",
          role: REVIEWER_ROLE,
          systems: [{ connector: adapterId, operation: "notify", binding_id: "review.notify", execution: "async_effect" }],
        },
        { id: "done", type: "event", label: "Done" },
      ],
      flow: [["start", "review"], ["review", "done"]],
    });
    workflows.add(workflow.id);
    const created = await createWorkflow(workflow, { lifecycleState: "executable" });
    expect(created.errors).toHaveLength(0);

    const kase = await createCase(workflow.id, "safe async adapter case", { observed: "runtime" });
    const workItemId = kase.history.find(entry => entry.element_id === "review")?.work_item_id;
    expect(workItemId).toBeDefined();
    expect(kase.status).toBe("running");
    expect(calls).toHaveLength(0);

    const idempotencyKey = `adapter.invoke:${kase.case_id}:${workItemId}:review.notify:${adapterId}:notify`;
    await expect(getRuntimeEffect(runtimeEffectIdFromIdempotencyKey(idempotencyKey))).resolves.toMatchObject({
      kind: "adapter.invoke",
      status: "pending",
      links: {
        workflow_id: workflow.id,
        case_id: kase.case_id,
        work_item_id: workItemId,
        adapter_id: adapterId,
      },
      payload: {
        connector: adapterId,
        operation: "notify",
        binding_id: "review.notify",
        input: { observed: "runtime" },
      },
    });
  });

  test("sync adapter bindings remain direct and can drive deterministic output", async () => {
    const adapterId = `${RUN}:adapter-sync-runtime`;
    registerAdapter(adapterId, adapter(adapterId));
    const workflow = makeWorkflowDefinition({
      id: `${RUN}:workflow-sync-runtime`,
      elements: [
        { id: "start", type: "event", label: "Start" },
        {
          id: "sync",
          type: "function",
          label: "Notify",
          role: REVIEWER_ROLE,
          systems: [{ connector: adapterId, operation: "notify", binding_id: "sync.notify" }],
        },
        { id: "done", type: "event", label: "Done" },
      ],
      flow: [["start", "sync"], ["sync", "done"]],
    });
    workflows.add(workflow.id);
    const created = await createWorkflow(workflow, { lifecycleState: "executable" });
    expect(created.errors).toHaveLength(0);

    const kase = await createCase(workflow.id, "sync adapter case", { observed: "sync" });
    const workItemId = kase.history.find(entry => entry.element_id === "sync")?.work_item_id;
    expect(kase.status).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ adapter: adapterId, action: "notify", input: { observed: "sync" } });

    const idempotencyKey = `adapter.invoke:${kase.case_id}:${workItemId}:sync.notify:${adapterId}:notify`;
    await expect(getRuntimeEffect(runtimeEffectIdFromIdempotencyKey(idempotencyKey))).resolves.toBeNull();
  });

  test("invalid adapter execution mode is rejected before deploy", () => {
    const workflow: WorkflowDefinition = makeWorkflowDefinition({
      id: `${RUN}:workflow-invalid-execution`,
      elements: [
        { id: "start", type: "event", label: "Start" },
        {
          id: "task",
          type: "function",
          label: "Task",
          role: REVIEWER_ROLE,
          systems: [{ connector: "telegram", operation: "send_message", execution: "background" as any }],
        },
        { id: "done", type: "event", label: "Done" },
      ],
      flow: [["start", "task"], ["task", "done"]],
    });

    const receipt = validateWorkflowReadiness(workflow);
    expect(receipt.errors).toContainEqual(expect.objectContaining({
      code: "ADAPTER_BINDING_INVALID",
      class: "adapter",
      element_id: "task",
    }));
  });

  test("malformed adapter execution values fail closed before deploy", () => {
    for (const [suffix, execution] of [
      ["boolean", true],
      ["object", { mode: "async_effect" }],
      ["null", null],
    ] as const) {
      const workflow: WorkflowDefinition = makeWorkflowDefinition({
        id: `${RUN}:workflow-malformed-execution-${suffix}`,
        elements: [
          { id: "start", type: "event", label: "Start" },
          {
            id: "task",
            type: "function",
            label: "Task",
            role: REVIEWER_ROLE,
            systems: [{ connector: "telegram", operation: "send_message", execution } as any],
          },
          { id: "done", type: "event", label: "Done" },
        ],
        flow: [["start", "task"], ["task", "done"]],
      });

      const receipt = validateWorkflowReadiness(workflow, { adapters: ["telegram"] });
      expect(receipt.errors).toContainEqual(expect.objectContaining({
        code: "ADAPTER_BINDING_INVALID",
        class: "adapter",
        element_id: "task",
      }));
    }
  });
});
