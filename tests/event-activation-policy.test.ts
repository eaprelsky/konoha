import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { deleteCasesByProcess, processEventWithActivation } from "../src/runtime";
import { createWorkflow, validateWorkflow, type WorkflowDefinition } from "../src/workflow-loader";
import { pgDeleteWorkflow } from "../src/storage/pg";
import { ACTIVATION_SUPPRESSIONS_STREAM, type WorkflowActivationPolicy } from "../src/event-activation-policy";

const redis = new Redis({ host: "127.0.0.1", port: 6379, db: parseInt(process.env.REDIS_DB ?? "0") });
const RUN = `activation-${Date.now()}`;
const touched = new Set<string>();

function wfId(name: string): string {
  return `${RUN}-${name}`;
}

function workflow(id: string, activation_policy?: WorkflowActivationPolicy): WorkflowDefinition {
  return {
    id,
    version: "1.0.0",
    name: `Activation ${id}`,
    triggers: [{
      event_type: "telegram.message.received",
      start_node: "start",
      ...(activation_policy ? { activation_policy } : {}),
    }],
    elements: [
      {
        id: "start",
        type: "event",
        label: "Telegram message received",
        trigger: {
          kind: "message",
          source: "telegram",
          filter: { chat_title: `${RUN} Leads` },
        },
      },
      { id: "triage", type: "function", label: "Triage message", role: "lead_triage" },
      { id: "done", type: "event", label: "Message triaged" },
    ],
    flow: [["start", "triage"], ["triage", "done"]],
  };
}

async function registerExecutable(def: WorkflowDefinition): Promise<void> {
  touched.add(def.id);
  const result = await createWorkflow(def, { lifecycleState: "executable" });
  if (result.errors.length > 0) {
    throw new Error(`workflow fixture failed validation: ${JSON.stringify(result.errors)}`);
  }
}

async function cleanupWorkflow(id: string): Promise<void> {
  await deleteCasesByProcess(id).catch(() => 0);
  await redis.del(`workflow:${id}`);
  await redis.srem("konoha:workflow:index", id);
  await pgDeleteWorkflow(id).catch(() => {});
}

async function countWorkItemsForWorkflow(id: string): Promise<number> {
  return (await redis.smembers(`konoha:workitems:process:${id}`).catch(() => [])).length;
}

function streamFields(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    out[fields[i]] = fields[i + 1];
  }
  return out;
}

beforeEach(async () => {
  await redis.del(ACTIVATION_SUPPRESSIONS_STREAM);
});

afterAll(async () => {
  for (const id of touched) await cleanupWorkflow(id);
  redis.disconnect();
});

describe("workflow event activation policy", () => {
  test("workflow validation requires activation policy for messenger start triggers", () => {
    const errors = validateWorkflow(workflow(wfId("missing-policy")));

    expect(errors.some(error =>
      error.rule === 7 &&
      error.message.includes("must define activation_policy")
    )).toBe(true);
  });

  test("dedup suppresses duplicate messenger activations with an inspectable reason", async () => {
    const id = wfId("dedup");
    await registerExecutable(workflow(id, {
      dedup_window_sec: 300,
      dedup_fields: ["chat_ref", "message_id"],
      inspect_suppressed: true,
    }));

    const payload = {
      chat_title: `${RUN} Leads`,
      chat_ref: "chat:dedup",
      message_id: "same-message",
      text: "Need a workflow",
    };
    const first = await processEventWithActivation("telegram.message.received", "telegram", payload, { workflowIds: [id] });
    const second = await processEventWithActivation("telegram.message.received", "telegram", payload, { workflowIds: [id] });

    expect(first.cases).toHaveLength(1);
    expect(first.decisions[0]).toMatchObject({ accepted: true, reason_code: "ACCEPTED" });
    expect(second.cases).toHaveLength(0);
    expect(second.decisions[0]).toMatchObject({ accepted: false, reason_code: "DUPLICATE", action: "suppress" });

    const suppressions = await redis.xrange(ACTIVATION_SUPPRESSIONS_STREAM, "-", "+");
    expect(suppressions).toHaveLength(1);
    expect(streamFields(suppressions[0][1])).toMatchObject({
      workflow_id: id,
      reason_code: "DUPLICATE",
      action: "suppress",
    });
  });

  test("confidence threshold suppresses low-confidence messenger activations", async () => {
    const id = wfId("confidence");
    await registerExecutable(workflow(id, {
      min_confidence: 0.75,
      confidence_field: "router_confidence",
      inspect_suppressed: true,
    }));

    const result = await processEventWithActivation("telegram.message.received", "telegram", {
      chat_title: `${RUN} Leads`,
      chat_ref: "chat:confidence",
      message_id: "low",
      router_confidence: "0.42",
      text: "maybe relevant",
    }, { workflowIds: [id] });

    expect(result.cases).toHaveLength(0);
    expect(result.decisions[0]).toMatchObject({
      accepted: false,
      reason_code: "LOW_CONFIDENCE",
      action: "suppress",
    });
  });

  test("rate limits keep cases and work items bounded under message bursts", async () => {
    const id = wfId("rate-limit");
    await registerExecutable(workflow(id, {
      rate_limit: {
        window_sec: 60,
        max_events: 5,
        scope: ["workflow", "chat"],
      },
      inspect_suppressed: true,
    }));

    const decisions = [];
    for (let i = 0; i < 40; i += 1) {
      const result = await processEventWithActivation("telegram.message.received", "telegram", {
        chat_title: `${RUN} Leads`,
        chat_ref: "chat:burst",
        message_id: `burst-${i}`,
        text: `burst ${i}`,
      }, { workflowIds: [id] });
      decisions.push(...result.decisions);
    }

    const accepted = decisions.filter(decision => decision.accepted);
    const throttled = decisions.filter(decision => decision.reason_code === "RATE_LIMITED");
    expect(accepted).toHaveLength(5);
    expect(throttled).toHaveLength(35);

    const cases = await redis.smembers(`konoha:cases:process:${id}`);
    expect(cases.length).toBeLessThanOrEqual(5);
    expect(await countWorkItemsForWorkflow(id)).toBeLessThanOrEqual(5);

    const suppressions = await redis.xrange(ACTIVATION_SUPPRESSIONS_STREAM, "-", "+");
    expect(suppressions.length).toBe(35);
  });

  test("backpressure suppresses new cases when workflow already has too many running cases", async () => {
    const id = wfId("backpressure");
    await registerExecutable(workflow(id, {
      backpressure: { max_running_cases: 1 },
      inspect_suppressed: true,
    }));

    const first = await processEventWithActivation("telegram.message.received", "telegram", {
      chat_title: `${RUN} Leads`,
      chat_ref: "chat:pressure",
      message_id: "one",
      text: "first",
    }, { workflowIds: [id] });
    const second = await processEventWithActivation("telegram.message.received", "telegram", {
      chat_title: `${RUN} Leads`,
      chat_ref: "chat:pressure",
      message_id: "two",
      text: "second",
    }, { workflowIds: [id] });

    expect(first.cases).toHaveLength(1);
    expect(second.cases).toHaveLength(0);
    expect(second.decisions[0]).toMatchObject({
      accepted: false,
      reason_code: "BACKPRESSURE",
      action: "throttle",
    });
  });
});
