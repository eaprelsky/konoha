import { afterAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { cleanupExpiredRuntimeArtifacts, InvalidRuntimeRetentionPolicyError } from "../src/retention/runtime-cleanup";
import type { Case, WorkItem } from "../src/runtime/cases";

const redis = new Redis({ host: "127.0.0.1", port: 6379, db: parseInt(process.env.REDIS_DB ?? "0", 10) });
const RUN = `test-retention-${Date.now()}`;

function iso(hoursAgo: number): string {
  return new Date(Date.parse("2026-05-17T12:00:00Z") - hoursAgo * 60 * 60 * 1000).toISOString();
}

async function saveCase(kase: Case): Promise<void> {
  await redis.set(`case:${kase.case_id}`, JSON.stringify(kase));
  await redis.zadd("konoha:cases:all", new Date(kase.created_at).getTime(), kase.case_id);
  await redis.sadd(`konoha:cases:status:${kase.status}`, kase.case_id);
  await redis.sadd(`konoha:cases:process:${kase.process_id}`, kase.case_id);
}

async function saveWorkItem(wi: WorkItem): Promise<void> {
  await redis.set(`workitem:${wi.work_item_id}`, JSON.stringify(wi));
  await redis.zadd("konoha:workitems:all", new Date(wi.created_at).getTime(), wi.work_item_id);
  await redis.sadd(`konoha:workitems:status:${wi.status}`, wi.work_item_id);
  await redis.sadd(`konoha:workitems:assignee:${wi.assignee}`, wi.work_item_id);
  if (wi.process_id) await redis.sadd(`konoha:workitems:process:${wi.process_id}`, wi.work_item_id);
  if (wi.case_id) await redis.sadd(`konoha:workitems:case:${wi.case_id}`, wi.work_item_id);
}

function kase(id: string, processId: string, status: Case["status"], updatedHoursAgo: number, payload: Record<string, unknown> = {}): Case {
  return {
    case_id: id,
    process_id: processId,
    process_version: "1",
    subject: id,
    status,
    position: "end",
    payload,
    history: [{ element_id: "end", element_type: "event", label: "End", timestamp: iso(updatedHoursAgo) }],
    created_at: iso(updatedHoursAgo + 1),
  };
}

function wi(id: string, caseId: string, processId: string, status: WorkItem["status"], assignee = "offline-agent"): WorkItem {
  return {
    work_item_id: id,
    case_id: caseId,
    process_id: processId,
    element_id: "f1",
    label: "Step",
    assignee,
    status,
    input: {},
    output: {},
    created_at: iso(30),
    updated_at: iso(30),
  };
}

async function cleanupRunKeys(): Promise<void> {
  const caseIds = await redis.zrange("konoha:cases:all", 0, -1);
  for (const id of caseIds.filter(id => id.includes(RUN))) {
    await redis.del(`case:${id}`);
    await redis.zrem("konoha:cases:all", id);
    await redis.srem("konoha:cases:status:running", id);
    await redis.srem("konoha:cases:status:done", id);
    await redis.srem("konoha:cases:status:error", id);
    await redis.srem("konoha:cases:status:cancelled", id);
  }
  const wiIds = await redis.zrange("konoha:workitems:all", 0, -1);
  for (const id of wiIds.filter(id => id.includes(RUN))) {
    await redis.del(`workitem:${id}`);
    await redis.zrem("konoha:workitems:all", id);
  }
  const keys = await redis.keys(`*${RUN}*`);
  if (keys.length > 0) await redis.del(...keys);
}

afterAll(async () => {
  await cleanupRunKeys();
  redis.disconnect();
});

describe("runtime retention cleanup", () => {
  test("rejects non-positive TTL policy overrides before scanning or deleting", async () => {
    const freshCaseId = `prod-${RUN}-fresh-opt-in`;
    await saveCase(kase(freshCaseId, "sales-lead", "done", 0, { retention: { auto_delete: true } }));

    const run = cleanupExpiredRuntimeArtifacts({
      dryRun: false,
      now: new Date("2026-05-17T12:00:00Z"),
      onlineAgentIds: new Set(),
      policy: { completedWorkflowTtlHours: -1, stuckCaseTtlHours: 24, maxDelete: 10 },
    });

    await expect(run).rejects.toThrow(InvalidRuntimeRetentionPolicyError);
    expect(await redis.get(`case:${freshCaseId}`)).not.toBeNull();
  });

  test("retention.runtime_cleanup rejects invalid action TTL args", async () => {
    const { executeActionDirect } = await import("../src/action-executor");
    const result = await executeActionDirect("retention.runtime_cleanup", {
      dry_run: false,
      completed_workflow_ttl_hours: -1,
      stuck_case_ttl_hours: 24,
      max_delete: 10,
    });

    expect(result?.status).toBe(400);
    expect(result?.data).toMatchObject({
      code: "INVALID_RUNTIME_RETENTION_POLICY",
      details: ["completedWorkflowTtlHours must be a positive number"],
    });
  });

  test("deletes old completed generated workflow runs with terminated work items", async () => {
    const caseId = `${RUN}-completed`;
    const processId = `test-${RUN}`;
    const workItemId = `${RUN}-completed-wi`;
    await saveCase(kase(caseId, processId, "done", 30));
    await saveWorkItem(wi(workItemId, caseId, processId, "done"));

    const result = await cleanupExpiredRuntimeArtifacts({
      dryRun: false,
      now: new Date("2026-05-17T12:00:00Z"),
      onlineAgentIds: new Set(),
      policy: { completedWorkflowTtlHours: 24, stuckCaseTtlHours: 24, maxDelete: 10 },
    });

    expect(result.deleted.map(candidate => candidate.id)).toContain(caseId);
    expect(await redis.get(`case:${caseId}`)).toBeNull();
    expect(await redis.get(`workitem:${workItemId}`)).toBeNull();
    expect(await redis.zscore("konoha:cases:all", caseId)).toBeNull();
    expect(await redis.sismember(`konoha:workitems:case:${caseId}`, workItemId)).toBe(0);
  });

  test("deletes old cancelled generated workflow runs with terminated work items", async () => {
    const caseId = `${RUN}-cancelled`;
    const processId = `test-${RUN}`;
    const workItemId = `${RUN}-cancelled-wi`;
    await saveCase(kase(caseId, processId, "cancelled", 30));
    await saveWorkItem(wi(workItemId, caseId, processId, "cancelled"));

    const result = await cleanupExpiredRuntimeArtifacts({
      dryRun: false,
      now: new Date("2026-05-17T12:00:00Z"),
      onlineAgentIds: new Set(),
      policy: { completedWorkflowTtlHours: 24, stuckCaseTtlHours: 24, maxDelete: 10 },
    });

    expect(result.deleted.map(candidate => candidate.id)).toContain(caseId);
    expect(await redis.get(`case:${caseId}`)).toBeNull();
    expect(await redis.sismember("konoha:cases:status:cancelled", caseId)).toBe(0);
    expect(await redis.get(`workitem:${workItemId}`)).toBeNull();
  });

  test("keeps production-looking completed cases unless explicitly opted in", async () => {
    const protectedCaseId = `prod-${RUN}-protected`;
    const optInCaseId = `prod-${RUN}-opt-in`;
    await saveCase(kase(protectedCaseId, "sales-lead", "done", 30));
    await saveCase(kase(optInCaseId, "sales-lead", "done", 30, { retention: { auto_delete: true } }));

    const result = await cleanupExpiredRuntimeArtifacts({
      dryRun: false,
      now: new Date("2026-05-17T12:00:00Z"),
      onlineAgentIds: new Set(),
      policy: { completedWorkflowTtlHours: 24, stuckCaseTtlHours: 24, maxDelete: 10 },
    });

    expect(result.deleted.map(candidate => candidate.id)).toContain(optInCaseId);
    expect(result.deleted.map(candidate => candidate.id)).not.toContain(protectedCaseId);
    expect(await redis.get(`case:${protectedCaseId}`)).not.toBeNull();
    expect(await redis.get(`case:${optInCaseId}`)).toBeNull();
  });

  test("deletes old generated stuck cases only when no active assignee is online", async () => {
    const offlineCaseId = `${RUN}-stuck-offline`;
    const onlineCaseId = `${RUN}-stuck-online`;
    await saveCase(kase(offlineCaseId, `test-${RUN}`, "running", 30));
    await saveWorkItem(wi(`${RUN}-stuck-offline-wi`, offlineCaseId, `test-${RUN}`, "running", "offline-agent"));
    await saveCase(kase(onlineCaseId, `test-${RUN}`, "running", 30));
    await saveWorkItem(wi(`${RUN}-stuck-online-wi`, onlineCaseId, `test-${RUN}`, "running", "online-agent"));

    const result = await cleanupExpiredRuntimeArtifacts({
      dryRun: false,
      now: new Date("2026-05-17T12:00:00Z"),
      onlineAgentIds: new Set(["online-agent"]),
      policy: { completedWorkflowTtlHours: 24, stuckCaseTtlHours: 24, maxDelete: 10 },
    });

    expect(result.deleted.map(candidate => candidate.id)).toContain(offlineCaseId);
    expect(result.deleted.map(candidate => candidate.id)).not.toContain(onlineCaseId);
    expect(await redis.get(`case:${offlineCaseId}`)).toBeNull();
    expect(await redis.get(`case:${onlineCaseId}`)).not.toBeNull();
  });
});
