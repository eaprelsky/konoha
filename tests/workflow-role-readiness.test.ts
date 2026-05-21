import { afterAll, describe, expect, test } from "bun:test";
import { executeActionDirect } from "../src/action-executor";
import { deleteCasesByProcess } from "../src/runtime";
import { createRole, deleteRole, loadRole } from "../src/runtime/roles";
import { pgDeleteWorkflow } from "../src/storage/pg";
import { createWorkflow, validateWorkflowReadiness, type WorkflowDefinition } from "../src/workflow-loader";
import { makeWorkflowDefinition } from "./factories";
import { createTestRedis } from "./redis-test-utils";

const redis = createTestRedis();
const RUN = `role-readiness-${Date.now()}`;
const touchedWorkflows = new Set<string>();
const touchedRoles = new Set<string>();

function workflow(role: string, overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return makeWorkflowDefinition({
    id: overrides.id ?? `${RUN}-${Math.random().toString(16).slice(2)}`,
    name: "Role readiness workflow",
    elements: [
      { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
      { id: "task", type: "function", label: "Review", role },
      { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
    ],
    flow: [["start", "task"], ["task", "done"]],
    ...overrides,
  });
}

async function cleanupWorkflow(id: string): Promise<void> {
  await deleteCasesByProcess(id).catch(() => 0);
  await redis.srem("konoha:workflow:index", id);
  await redis.del(`workflow:${id}`);
  await redis.del(`konoha:workflow:versionctr:${id}`);
  await pgDeleteWorkflow(id).catch(() => {});
}

afterAll(async () => {
  for (const id of touchedWorkflows) await cleanupWorkflow(id);
  for (const roleId of touchedRoles) await deleteRole(roleId).catch(() => {});
  redis.disconnect();
});

describe("workflow role readiness", () => {
  test("accepts system roles, explicit manual queues, direct agents, capabilities, and people", () => {
    expect(validateWorkflowReadiness(workflow("System"), {
      roles: [],
      agents: [],
      people: [],
    }).errors.filter(error => error.class === "role")).toEqual([]);

    expect(validateWorkflowReadiness(workflow("manual-review"), {
      roles: [{ role_id: "manual-review", assignees: [], strategy: "manual" }],
      agents: [],
      people: [],
    }).errors.filter(error => error.class === "role")).toEqual([]);

    expect(validateWorkflowReadiness(workflow("implicit-manual-review"), {
      roles: [{ role_id: "implicit-manual-review", assignees: [], strategy: "manual", origin: "workflow_skeleton" }],
      agents: [],
      people: [],
    }).errors).toContainEqual(expect.objectContaining({
      code: "ROLE_UNRESOLVABLE",
      class: "role",
      element_id: "task",
    }));

    expect(validateWorkflowReadiness(workflow("kakashi"), {
      roles: [{ role_id: "kakashi", assignees: [], strategy: "manual", origin: "workflow_skeleton" }],
      agents: [{ id: "kakashi", name: "SDD team lead", capabilities: ["developer"], status: "online" }],
      people: [],
    }).errors.filter(error => error.class === "role")).toEqual([]);

    expect(validateWorkflowReadiness(workflow("kakashi"), {
      roles: [],
      agents: [{ id: "kakashi", name: "SDD team lead", capabilities: ["developer"], status: "online" }],
      people: [],
    }).errors.filter(error => error.class === "role")).toEqual([]);

    expect(validateWorkflowReadiness(workflow("developer"), {
      roles: [],
      agents: [{ id: "guy", name: "SDD developer", capabilities: ["developer"], status: "online" }],
      people: [],
    }).errors.filter(error => error.class === "role")).toEqual([]);

    expect(validateWorkflowReadiness(workflow("Owner"), {
      roles: [],
      agents: [],
      people: [{ id: "owner", name: "Yegor", position: "Owner", tg_id: 42 }],
    }).errors.filter(error => error.class === "role")).toEqual([]);
  });

  test("blocks unresolved role names with stable machine-readable receipt code", () => {
    const receipt = validateWorkflowReadiness(workflow("missing-role"), {
      roles: [],
      agents: [{ id: "offline-agent", name: "Missing", capabilities: ["missing-role"], status: "offline" }],
      people: [{ id: "ops", name: "Ops", position: "Operations" }],
    });

    expect(receipt).toMatchObject({
      readiness: "blocked",
      gates: {
        deployment_blocker: true,
        case_start_blocker: true,
        release_blocker: true,
      },
    });
    expect(receipt.errors).toContainEqual(expect.objectContaining({
      code: "ROLE_UNRESOLVABLE",
      class: "role",
      legacy_code: "RUNTIME_UNRESOLVABLE_ROLE",
      element_id: "task",
    }));
  });

  test("blocks non-manual RoleDef assignees that cannot route to agent or person", () => {
    const receipt = validateWorkflowReadiness(workflow("reviewer"), {
      roles: [{ role_id: "reviewer", assignees: ["offline-agent", "unknown-person"], strategy: "round-robin" }],
      agents: [{ id: "offline-agent", name: "Offline", capabilities: [], status: "offline" }],
      people: [{ id: "known-person", name: "Known", position: "Reviewer", tg_id: 77 }],
    });

    expect(receipt.errors).toContainEqual(expect.objectContaining({
      code: "ROLE_ASSIGNEE_UNRESOLVABLE",
      class: "role",
      legacy_code: "RUNTIME_UNRESOLVABLE_ROLE_ASSIGNEE",
      element_id: "task",
    }));
  });

  test("accepts RoleDef assignees that resolve to online agents or Telegram-reachable people", () => {
    const agentReceipt = validateWorkflowReadiness(workflow("reviewer"), {
      roles: [{ role_id: "reviewer", assignees: ["kakashi"], strategy: "round-robin" }],
      agents: [{ id: "kakashi", name: "SDD team lead", capabilities: [], status: "online" }],
      people: [],
    });
    expect(agentReceipt.errors.filter(error => error.class === "role")).toEqual([]);

    const personReceipt = validateWorkflowReadiness(workflow("legal-reviewer"), {
      roles: [{ role_id: "legal-reviewer", assignees: ["@yegor"], strategy: "load-balancing" }],
      agents: [],
      people: [{ id: "yegor", name: "Yegor", tg_username: "yegor", tg_id: 42 }],
    });
    expect(personReceipt.errors.filter(error => error.class === "role")).toEqual([]);
  });

  test("workflow.deploy blocks unresolved role readiness before executable state", async () => {
    const workflowId = `${RUN}-deploy-blocked`;
    const roleId = `${RUN}-deploy-role`;
    touchedWorkflows.add(workflowId);
    touchedRoles.add(roleId);

    await createRole({
      role_id: roleId,
      name: "Deploy role",
      description: "Invalid deploy role",
      assignees: [`${RUN}-missing-agent`],
      strategy: "round-robin",
      required_capabilities: [],
    });
    await createWorkflow(workflow(roleId, {
      id: workflowId,
      elements: [
        { id: "start", type: "event", label: "Start", trigger: { kind: "timer", cron: "*/5 * * * *", confidence: 1 } },
        { id: "task", type: "function", label: "Review", role: roleId },
        { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
      ],
    }));

    const deployed = await executeActionDirect("workflow.deploy", { id: workflowId, deployed_by: "operator-1" });

    expect(deployed?.status).toBe(422);
    expect((deployed?.data as any)).toMatchObject({
      code: "WORKFLOW_VALIDATION_BLOCKED",
      process_id: workflowId,
      validation: {
        readiness: "blocked",
        gates: {
          deployment_blocker: true,
          case_start_blocker: true,
        },
      },
    });
    expect((deployed?.data as any).validation.errors).toContainEqual(expect.objectContaining({
      code: "ROLE_ASSIGNEE_UNRESOLVABLE",
      class: "role",
      element_id: "task",
    }));
  });

  test("auto-created skeleton roles do not bypass workflow.deploy role readiness", async () => {
    const workflowId = `${RUN}-implicit-role-deploy`;
    const roleId = `${RUN}-implicit-missing-role`;
    touchedWorkflows.add(workflowId);
    touchedRoles.add(roleId);

    await createWorkflow(workflow(roleId, {
      id: workflowId,
      elements: [
        { id: "start", type: "event", label: "Start", trigger: { kind: "timer", cron: "*/5 * * * *", confidence: 1 } },
        { id: "task", type: "function", label: "Review", role: roleId },
        { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
      ],
    }));
    await expect(loadRole(roleId)).resolves.toMatchObject({
      role_id: roleId,
      strategy: "manual",
      assignees: [],
      origin: "workflow_skeleton",
    });

    const deployed = await executeActionDirect("workflow.deploy", { id: workflowId, deployed_by: "operator-1" });

    expect(deployed?.status).toBe(422);
    expect((deployed?.data as any)).toMatchObject({
      code: "WORKFLOW_VALIDATION_BLOCKED",
      process_id: workflowId,
      validation: {
        readiness: "blocked",
        gates: {
          deployment_blocker: true,
          case_start_blocker: true,
        },
      },
    });
    expect((deployed?.data as any).validation.errors).toContainEqual(expect.objectContaining({
      code: "ROLE_UNRESOLVABLE",
      class: "role",
      element_id: "task",
      details: expect.objectContaining({
        role: roleId,
      }),
    }));
  });
});
