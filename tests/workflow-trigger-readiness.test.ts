import { afterAll, describe, expect, test } from "bun:test";
import { executeActionDirect } from "../src/action-executor";
import { createWorkflow, validateWorkflowReadiness, type WorkflowDefinition, type WorkflowElement } from "../src/workflow-loader";
import { deleteCasesByProcess } from "../src/runtime";
import { pgDeleteWorkflow } from "../src/storage/pg";
import { SUBSCRIPTIONS_KEY } from "../src/events/subscriptions";
import { createTestRedis } from "./redis-test-utils";
import { makeWorkflowDefinition } from "./factories";

const redis = createTestRedis();
const RUN = `trigger-readiness-${Date.now()}`;
const touched = new Set<string>();

function workflow(trigger?: WorkflowElement["trigger"], overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return makeWorkflowDefinition({
    id: `${RUN}-${Math.random().toString(16).slice(2)}`,
    elements: [
      { id: "start", type: "event", label: "Start", ...(trigger ? { trigger } : {}) },
      { id: "task", type: "function", label: "Review", role: "Operator" },
      { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
    ],
    flow: [["start", "task"], ["task", "done"]],
    ...overrides,
  });
}

function deployCodes(def: WorkflowDefinition): string[] {
  return validateWorkflowReadiness(def, { source: "workflow.deploy" }).errors.map(error => error.code);
}

async function cleanupWorkflow(id: string): Promise<void> {
  await deleteCasesByProcess(id).catch(() => 0);
  await redis.del(`workflow:${id}`);
  await redis.srem("konoha:workflow:index", id);
  await pgDeleteWorkflow(id).catch(() => {});
}

async function activeSubscriptionsForProcess(id: string): Promise<number> {
  const raw = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({} as Record<string, string>));
  return Object.values(raw).filter(value => {
    try {
      const sub = JSON.parse(value);
      return sub.process_id === id && sub.status === "active";
    } catch {
      return false;
    }
  }).length;
}

afterAll(async () => {
  for (const id of touched) await cleanupWorkflow(id);
  redis.disconnect();
});

describe("workflow trigger readiness validation", () => {
  test("valid trigger descriptors pass deploy readiness", () => {
    const codes = deployCodes(workflow({ kind: "timer", cron: "*/5 * * * *", confidence: 1 }));

    expect(codes).not.toContain("TRIGGER_READINESS_INVALID");
    expect(codes).not.toContain("DEPLOYMENT_START_TRIGGER_UNRESOLVED");
  });

  test("timer descriptors are cron-only; delayed timers must use delay_after kind", () => {
    const codes = deployCodes(workflow({
      kind: "timer",
      delay_after: { duration: "PT5M" },
      confidence: 1,
    } as any));

    expect(codes).toContain("TRIGGER_READINESS_INVALID");
    expect(deployCodes(workflow({ kind: "delay_after", duration: "PT5M", confidence: 1 }))).not.toContain("TRIGGER_READINESS_INVALID");
  });

  test("missing start trigger blocks deploy readiness before materialization", () => {
    expect(deployCodes(workflow())).toContain("DEPLOYMENT_START_TRIGGER_UNRESOLVED");
  });

  test("ambiguous resolver output is classified as a trigger blocker", () => {
    expect(deployCodes(workflow({ kind: "ambiguous", candidates: [], confidence: 0 }))).toContain("TRIGGER_AMBIGUOUS");
  });

  test("unsupported trigger kinds remain machine-readable trigger blockers", () => {
    expect(deployCodes(workflow({ kind: "webhook" } as any))).toContain("TRIGGER_UNSUPPORTED_KIND");
  });

  test("terminal event triggers block deployment readiness", () => {
    const def = workflow({ kind: "manual", manual_override: true }, {
      elements: [
        { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
        { id: "task", type: "function", label: "Review", role: "Operator" },
        { id: "done", type: "event", label: "Done", trigger: { kind: "message", source: "telegram", filter: {}, confidence: 1 } },
      ],
    });

    expect(deployCodes(def)).toContain("DEPLOYMENT_TERMINAL_EVENT_HAS_TRIGGER");
  });

  test("workflow.deploy blocks invalid trigger descriptors before subscriptions are created", async () => {
    const def = workflow({ kind: "timer", cron: "not a cron", confidence: 1 });
    touched.add(def.id);
    await createWorkflow(def);

    const deployed = await executeActionDirect("workflow.deploy", { id: def.id });

    expect(deployed?.status).toBe(422);
    expect((deployed?.data as any)).toMatchObject({
      code: "WORKFLOW_VALIDATION_BLOCKED",
      process_id: def.id,
      validation: { readiness: "blocked" },
    });
    expect((deployed?.data as any).validation.errors).toContainEqual(expect.objectContaining({
      code: "TRIGGER_READINESS_INVALID",
      legacy_code: "DEPLOYMENT_TRIGGER_INVALID",
      class: "trigger",
    }));
    expect(await activeSubscriptionsForProcess(def.id)).toBe(0);
  });
});
