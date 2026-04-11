/**
 * Unit tests for runtime/cases.ts — issue #410 logic (child case creation via sub_process_id).
 * Covers issue #461: unit-тест advanceCase() с resolveChildProcess через sub_process_id.
 *
 * Design notes:
 * - Workflows are registered via createWorkflow (Redis) + pgUpsertWorkflow (PG, awaited)
 *   so that getWorkflow works in both PG_READ=true and Redis modes.
 * - Case/WI queries use Redis directly (via test redis client) to avoid races
 *   caused by fire-and-forget pgUpsert* calls inside the runtime.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Redis from "ioredis";
import { createCase } from "../src/runtime";
import { createWorkflow } from "../src/workflow-loader";
import { pgUpsertWorkflow, pgDeleteWorkflow } from "../src/storage/pg";
import type { WorkflowDefinition } from "../src/workflow-loader";

// Test redis on the isolated DB (DB 1 set by tests/setup.ts preload)
const redis = new Redis({ host: "127.0.0.1", port: 6379, db: parseInt(process.env.REDIS_DB ?? "0") });

const RUN = `cu${Date.now()}`;
function wfId(name: string) { return `${name}-${RUN}`; }

/** Load a case directly from Redis, bypassing PG_READ. */
async function loadCaseFromRedis(case_id: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(`case:${case_id}`);
  return raw ? JSON.parse(raw) : null;
}

/** Load a work item directly from Redis, bypassing PG_READ. */
async function loadWIFromRedis(work_item_id: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(`workitem:${work_item_id}`);
  return raw ? JSON.parse(raw) : null;
}

/** List work item IDs for a case from Redis index, bypassing PG_READ. */
async function listWIIdsFromRedis(case_id: string): Promise<string[]> {
  return redis.smembers(`konoha:workitems:case:${case_id}`);
}

async function registerWorkflow(def: WorkflowDefinition): Promise<void> {
  // Write to Redis AND await PG write so getWorkflow finds it in both read modes.
  await createWorkflow(def, { draft: true });
  await pgUpsertWorkflow(def as any);
}

async function cleanupWorkflow(id: string): Promise<void> {
  await redis.del(`workflow:${id}`);
  await redis.srem("konoha:workflow:index", id);
  await pgDeleteWorkflow(id).catch(() => {});
}

// ── Workflow definitions ──────────────────────────────────────────────────────

/**
 * Parent workflow: e1(start) → f1(function, sub_process_id=child) → e2(end)
 * f1 has sub_process_id set → resolveChildProcess uses the fast O(1) path (issue #460).
 */
function parentWorkflow(): WorkflowDefinition {
  return {
    id: wfId("parent"),
    version: "1.0.0",
    name: "Parent Workflow (test)",
    elements: [
      { id: "e1", type: "event",    label: "Start" },
      { id: "f1", type: "function", label: "Sub-process Call", sub_process_id: wfId("child") },
      { id: "e2", type: "event",    label: "End" },
    ],
    flow: [
      ["e1", "f1"],
      ["f1", "e2"],
    ],
  };
}

/**
 * Trivial child: single start event, no outgoing edges.
 * advanceCase sees nexts.length===0 at the event → immediately marks status="done".
 */
function trivialChildWorkflow(): WorkflowDefinition {
  return {
    id: wfId("child"),
    version: "1.0.0",
    name: "Trivial Child (test)",
    parent_id: wfId("parent"),
    parent_function_id: "f1",
    elements: [
      { id: "ce1", type: "event", label: "Instant Done" },
    ],
    flow: [],
  };
}

/**
 * Blocking child: start event → manual function (role=tester) → end event.
 * After createCase the child stays "running" (waiting for a human to complete cf1).
 */
function blockingChildWorkflow(): WorkflowDefinition {
  return {
    id: wfId("child"),
    version: "1.0.0",
    name: "Blocking Child (test)",
    parent_id: wfId("parent"),
    parent_function_id: "f1",
    elements: [
      { id: "ce1", type: "event",    label: "Child Start" },
      { id: "cf1", type: "function", label: "Manual Step", role: "tester" },
      { id: "ce2", type: "event",    label: "Child End" },
    ],
    flow: [
      ["ce1", "cf1"],
      ["cf1", "ce2"],
    ],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("advanceCase: sub-process detection via sub_process_id (issue #410)", () => {
  beforeAll(async () => {
    await registerWorkflow(parentWorkflow());
  });

  afterAll(async () => {
    await cleanupWorkflow(wfId("parent"));
    await cleanupWorkflow(wfId("child")).catch(() => {});
    redis.disconnect();
  });

  test("trivial child — parent advances past f1 and pauses at the end event", async () => {
    await registerWorkflow(trivialChildWorkflow());
    try {
      // Trivial child (single terminal event) completes immediately.
      // advanceCase in the parent continues past f1 → stops at e2 (intermediate event in eEPC).
      const kase = await createCase(wfId("parent"), "test-trivial", {});

      // Parent moved PAST f1 (the sub-process call) — key assertion for issue #410
      expect(kase.position).toBe("e2");
      // f1 must appear in history — child was launched and its WI marked done inline
      expect(kase.history.some(h => h.element_id === "f1")).toBe(true);
      // Parent is still running (waiting at intermediate end event e2 for external trigger)
      expect(kase.status).toBe("running");
    } finally {
      await cleanupWorkflow(wfId("child"));
    }
  });

  test("blocking child — parent suspends at f1, child case is created", async () => {
    await registerWorkflow(blockingChildWorkflow());
    try {
      const parentCase = await createCase(wfId("parent"), "test-blocking", {});

      // Parent suspends at f1, waiting for child to complete
      expect(parentCase.status).toBe("running");
      expect(parentCase.position).toBe("f1");

      // f1 must be in history with a work_item_id
      const histF1 = parentCase.history.find(h => h.element_id === "f1");
      expect(histF1).toBeDefined();
      expect(histF1!.work_item_id).toBeDefined();

      // Work item for f1 must exist in Redis and be pending
      const wi = await loadWIFromRedis(histF1!.work_item_id!);
      expect(wi).not.toBeNull();
      expect(wi!.status).toBe("pending");

      // Work item must link to a child case
      expect(wi!.child_case_id).toBeDefined();
      const childCase = await loadCaseFromRedis(wi!.child_case_id as string);
      expect(childCase).not.toBeNull();
      expect(childCase!.process_id).toBe(wfId("child"));
      expect(childCase!.status).toBe("running");
      expect(childCase!.parent_work_item_id).toBe(histF1!.work_item_id);
    } finally {
      await cleanupWorkflow(wfId("child"));
    }
  });

  test("payload is inherited by child case", async () => {
    await registerWorkflow(blockingChildWorkflow());
    try {
      const payload = { order_id: "ORD-42", amount: 100 };
      const parentCase = await createCase(wfId("parent"), "test-payload", payload);

      const histF1 = parentCase.history.find(h => h.element_id === "f1");
      expect(histF1?.work_item_id).toBeDefined();

      const wi = await loadWIFromRedis(histF1!.work_item_id!);
      expect(wi!.child_case_id).toBeDefined();

      const childCase = await loadCaseFromRedis(wi!.child_case_id as string);
      expect(childCase!.payload).toMatchObject(payload);
    } finally {
      await cleanupWorkflow(wfId("child"));
    }
  });
});
