/**
 * KWE-004: Gateway operator tests (AND / XOR / OR)
 *
 * Tests run against real Redis. Workflows are registered directly into Redis
 * (bypassing the file loader) so each test is self-contained.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Redis from "ioredis";
import { createCase, completeWorkItem, getCase, listWorkItems } from "../src/runtime";
import type { WorkflowDefinition } from "../src/workflow-loader";

const redis = new Redis({ host: "127.0.0.1", port: 6379 });

// Unique suffix per test run to avoid key collisions
const RUN = `gw${Date.now()}`;
function wfKey(id: string) { return `workflow:${id}-${RUN}`; }
function wfId(id: string) { return `${id}-${RUN}`; }

async function registerWorkflow(def: WorkflowDefinition): Promise<void> {
  await redis.set(`workflow:${def.id}`, JSON.stringify(def));
}

async function cleanupWorkflows() {
  const keys = await redis.keys(`workflow:*-${RUN}`);
  if (keys.length) await redis.del(...keys);
}

// ── Workflow definitions ──────────────────────────────────────────────────────

/**
 * XOR split workflow:
 *   e1 → f1 → e2 → g1(XOR) → f2 [if path==='a'] → e3
 *                           → f3 [if path==='b'] → e4
 */
function xorWorkflow(): WorkflowDefinition {
  return {
    id: wfId("xor"),
    version: "1.0.0",
    name: "XOR Gateway Test",
    elements: [
      { id: "e1", type: "event",    label: "Start" },
      { id: "f1", type: "function", label: "Prepare",  role: "tester" },
      { id: "e2", type: "event",    label: "Prepared" },
      { id: "g1", type: "gateway",  label: "Route",    operator: "XOR" },
      { id: "f2", type: "function", label: "Path A",   role: "tester" },
      { id: "f3", type: "function", label: "Path B",   role: "tester" },
      { id: "e3", type: "event",    label: "Done A" },
      { id: "e4", type: "event",    label: "Done B" },
    ],
    flow: [
      ["e1", "f1"],
      ["f1", "e2"],
      ["e2", "g1"],
      ["g1", "f2", "payload.path === 'a'"],
      ["g1", "f3", "payload.path === 'b'"],
      ["f2", "e3"],
      ["f3", "e4"],
    ],
  };
}

/**
 * AND split/join workflow:
 *   e1 → f1 → e_split → g1(AND) → f2 → e_a → g2(AND) → f4 → e2
 *                                → f3 → e_b →/
 * Intermediate events added to satisfy eEPC alternation rule (no function→gateway→function).
 */
function andWorkflow(): WorkflowDefinition {
  return {
    id: wfId("and"),
    version: "1.0.0",
    name: "AND Gateway Test",
    elements: [
      { id: "e1",      type: "event",    label: "Start" },
      { id: "f1",      type: "function", label: "Trigger",    role: "tester" },
      { id: "e_split", type: "event",    label: "Trigger Done" },
      { id: "g1",      type: "gateway",  label: "Split",      operator: "AND" },
      { id: "f2",      type: "function", label: "Branch A",   role: "tester" },
      { id: "f3",      type: "function", label: "Branch B",   role: "tester" },
      { id: "e_a",     type: "event",    label: "Branch A Done" },
      { id: "e_b",     type: "event",    label: "Branch B Done" },
      { id: "g2",      type: "gateway",  label: "Join",       operator: "AND" },
      { id: "f4",      type: "function", label: "After Join", role: "tester" },
      { id: "e2",      type: "event",    label: "Done" },
    ],
    flow: [
      ["e1",      "f1"],
      ["f1",      "e_split"],
      ["e_split", "g1"],
      ["g1",      "f2"],
      ["g1",      "f3"],
      ["f2",      "e_a"],
      ["f3",      "e_b"],
      ["e_a",     "g2"],
      ["e_b",     "g2"],
      ["g2",      "f4"],
      ["f4",      "e2"],
    ],
  };
}

/**
 * OR split/join workflow:
 *   e1 → f1 → e_split → g1(OR) → f2 [if flag_a===true] → e_a → g2(OR) → f4 → e2
 *                               → f3 [if flag_b===true] → e_b →/
 * Intermediate events added to satisfy eEPC alternation rule (no function→gateway→function).
 */
function orWorkflow(): WorkflowDefinition {
  return {
    id: wfId("or"),
    version: "1.0.0",
    name: "OR Gateway Test",
    elements: [
      { id: "e1",      type: "event",    label: "Start" },
      { id: "f1",      type: "function", label: "Trigger",    role: "tester" },
      { id: "e_split", type: "event",    label: "Trigger Done" },
      { id: "g1",      type: "gateway",  label: "OR Split",   operator: "OR" },
      { id: "f2",      type: "function", label: "Branch A",   role: "tester" },
      { id: "f3",      type: "function", label: "Branch B",   role: "tester" },
      { id: "e_a",     type: "event",    label: "Branch A Done" },
      { id: "e_b",     type: "event",    label: "Branch B Done" },
      { id: "g2",      type: "gateway",  label: "OR Join",    operator: "OR" },
      { id: "f4",      type: "function", label: "After Join", role: "tester" },
      { id: "e2",      type: "event",    label: "Done" },
    ],
    flow: [
      ["e1",      "f1"],
      ["f1",      "e_split"],
      ["e_split", "g1"],
      ["g1",      "f2", "payload.flag_a === true"],
      ["g1",      "f3", "payload.flag_b === true"],
      ["f2",      "e_a"],
      ["f3",      "e_b"],
      ["e_a",     "g2"],
      ["e_b",     "g2"],
      ["g2",      "f4"],
      ["f4",      "e2"],
    ],
  };
}

beforeAll(async () => {
  await registerWorkflow(xorWorkflow());
  await registerWorkflow(andWorkflow());
  await registerWorkflow(orWorkflow());
});

afterAll(async () => {
  await cleanupWorkflows();
  redis.disconnect();
});

// ── XOR gateway tests ─────────────────────────────────────────────────────────

describe("XOR gateway", () => {
  test("splits to path A when condition matches", async () => {
    const kase = await createCase(wfId("xor"), "xor-path-a", { path: "a" });

    // After start, f1 should be the first work item
    expect(kase.status).toBe("running");
    expect(kase.position).toBe("f1");

    const f1wi = kase.history.find(h => h.element_id === "f1")!;
    expect(f1wi).toBeDefined();
    expect(f1wi.work_item_id).toBeDefined();

    // Complete f1 → advance through e2 → XOR → should stop at f2
    const { case: updated } = await completeWorkItem(f1wi.work_item_id!, {});
    expect(updated!.position).toBe("f2");
    expect(updated!.active_branches).toBeUndefined();

    // Only Path A should be in this case's history (not Path B)
    const histLabels = updated!.history.map(h => h.label);
    expect(histLabels).toContain("Path A");
    expect(histLabels).not.toContain("Path B");
  });

  test("splits to path B when condition matches", async () => {
    const kase = await createCase(wfId("xor"), "xor-path-b", { path: "b" });
    const f1wi = kase.history.find(h => h.element_id === "f1")!;

    const { case: updated } = await completeWorkItem(f1wi.work_item_id!, {});
    expect(updated!.position).toBe("f3");

    // Only Path B should be in this case's history (not Path A)
    const histLabels = updated!.history.map(h => h.label);
    expect(histLabels).toContain("Path B");
    expect(histLabels).not.toContain("Path A");
  });

  test("completes case when XOR branch work item is done", async () => {
    const kase = await createCase(wfId("xor"), "xor-complete", { path: "a" });
    const f1wi = kase.history.find(h => h.element_id === "f1")!;

    const { case: atF2 } = await completeWorkItem(f1wi.work_item_id!, {});
    const f2wi = atF2!.history.find(h => h.element_id === "f2")!;

    const { case: done } = await completeWorkItem(f2wi.work_item_id!, {});
    expect(done!.status).toBe("done");

    // e3 (Done A) should be in history
    const histLabels = done!.history.map(h => h.label);
    expect(histLabels).toContain("Done A");
    expect(histLabels).not.toContain("Done B");
  });

  test("sets case to error when no XOR condition matches", async () => {
    const kase = await createCase(wfId("xor"), "xor-no-match", { path: "unknown" });
    const f1wi = kase.history.find(h => h.element_id === "f1")!;

    const { case: updated } = await completeWorkItem(f1wi.work_item_id!, {});
    expect(updated!.status).toBe("error");
  });
});

// ── AND gateway tests ─────────────────────────────────────────────────────────

describe("AND gateway", () => {
  test("AND split creates work items for all branches", async () => {
    const kase = await createCase(wfId("and"), "and-split", {});
    // After start, f1 should be first
    const f1wi = kase.history.find(h => h.element_id === "f1")!;

    const { case: atSplit } = await completeWorkItem(f1wi.work_item_id!, {});

    // Position should be at the AND split gateway (g1)
    expect(atSplit!.position).toBe("g1");
    expect(atSplit!.active_branches).toBeDefined();
    expect(atSplit!.active_branches!.length).toBe(2);

    const branchElements = atSplit!.active_branches!.map(b => b.element_id);
    expect(branchElements).toContain("f2");
    expect(branchElements).toContain("f3");

    // Both branches should have pending work items
    const branchA = atSplit!.active_branches!.find(b => b.element_id === "f2")!;
    const branchB = atSplit!.active_branches!.find(b => b.element_id === "f3")!;
    expect(branchA.done).toBe(false);
    expect(branchB.done).toBe(false);
  });

  test("AND join waits for all branches before advancing", async () => {
    const kase = await createCase(wfId("and"), "and-join-partial", {});
    const f1wi = kase.history.find(h => h.element_id === "f1")!;

    const { case: atSplit } = await completeWorkItem(f1wi.work_item_id!, {});
    const branchA = atSplit!.active_branches!.find(b => b.element_id === "f2")!;
    const branchB = atSplit!.active_branches!.find(b => b.element_id === "f3")!;

    // Complete only branch A — case should still be waiting
    const { case: afterA } = await completeWorkItem(branchA.work_item_id, {});
    expect(afterA!.status).toBe("running");
    expect(afterA!.active_branches).toBeDefined();
    expect(afterA!.active_branches!.find(b => b.element_id === "f2")!.done).toBe(true);
    expect(afterA!.active_branches!.find(b => b.element_id === "f3")!.done).toBe(false);
    // Position still at split gateway
    expect(afterA!.position).toBe("g1");

    // Complete branch B — should advance past join
    const { case: afterBoth } = await completeWorkItem(branchB.work_item_id, {});
    expect(afterBoth!.active_branches).toBeUndefined();
    expect(afterBoth!.position).toBe("f4");
  });

  test("AND join advances to next element after all branches complete", async () => {
    const kase = await createCase(wfId("and"), "and-full", {});
    const f1wi = kase.history.find(h => h.element_id === "f1")!;

    const { case: atSplit } = await completeWorkItem(f1wi.work_item_id!, {});
    const branchA = atSplit!.active_branches!.find(b => b.element_id === "f2")!;
    const branchB = atSplit!.active_branches!.find(b => b.element_id === "f3")!;

    await completeWorkItem(branchA.work_item_id, {});
    const { case: atF4 } = await completeWorkItem(branchB.work_item_id, {});

    // Should now be at f4 (after join)
    expect(atF4!.position).toBe("f4");
    const f4wi = atF4!.history.find(h => h.element_id === "f4")!;
    expect(f4wi).toBeDefined();

    // Complete f4 → case done
    const { case: done } = await completeWorkItem(f4wi.work_item_id!, {});
    expect(done!.status).toBe("done");
    const histLabels = done!.history.map(h => h.label);
    expect(histLabels).toContain("join");
    expect(histLabels).toContain("Done");
  });
});

// ── OR gateway tests ──────────────────────────────────────────────────────────

describe("OR gateway", () => {
  test("OR split spawns only branches with matching conditions", async () => {
    // Only flag_a is true — only Branch A should be spawned
    const kase = await createCase(wfId("or"), "or-single-branch", { flag_a: true, flag_b: false });
    const f1wi = kase.history.find(h => h.element_id === "f1")!;

    const { case: atSplit } = await completeWorkItem(f1wi.work_item_id!, {});

    expect(atSplit!.active_branches).toBeDefined();
    expect(atSplit!.active_branches!.length).toBe(1);
    expect(atSplit!.active_branches![0].element_id).toBe("f2");
  });

  test("OR split spawns all matching branches", async () => {
    // Both flags true — both branches spawned
    const kase = await createCase(wfId("or"), "or-both-branches", { flag_a: true, flag_b: true });
    const f1wi = kase.history.find(h => h.element_id === "f1")!;

    const { case: atSplit } = await completeWorkItem(f1wi.work_item_id!, {});

    expect(atSplit!.active_branches!.length).toBe(2);
    const elements = atSplit!.active_branches!.map(b => b.element_id);
    expect(elements).toContain("f2");
    expect(elements).toContain("f3");
  });

  test("OR sets error when no branch condition matches", async () => {
    const kase = await createCase(wfId("or"), "or-no-match", { flag_a: false, flag_b: false });
    const f1wi = kase.history.find(h => h.element_id === "f1")!;

    const { case: updated } = await completeWorkItem(f1wi.work_item_id!, {});
    expect(updated!.status).toBe("error");
  });

  test("OR join advances when single active branch completes", async () => {
    const kase = await createCase(wfId("or"), "or-join-single", { flag_a: true, flag_b: false });
    const f1wi = kase.history.find(h => h.element_id === "f1")!;

    const { case: atSplit } = await completeWorkItem(f1wi.work_item_id!, {});
    const branchA = atSplit!.active_branches![0];

    // Complete the single branch → should advance to f4
    const { case: atF4 } = await completeWorkItem(branchA.work_item_id, {});
    expect(atF4!.position).toBe("f4");
    expect(atF4!.active_branches).toBeUndefined();
  });

  test("OR join waits for all active branches before advancing", async () => {
    const kase = await createCase(wfId("or"), "or-join-both", { flag_a: true, flag_b: true });
    const f1wi = kase.history.find(h => h.element_id === "f1")!;

    const { case: atSplit } = await completeWorkItem(f1wi.work_item_id!, {});
    const branchA = atSplit!.active_branches!.find(b => b.element_id === "f2")!;
    const branchB = atSplit!.active_branches!.find(b => b.element_id === "f3")!;

    // Complete A only → still waiting
    const { case: afterA } = await completeWorkItem(branchA.work_item_id, {});
    expect(afterA!.status).toBe("running");
    expect(afterA!.active_branches).toBeDefined();

    // Complete B → advance
    const { case: atF4 } = await completeWorkItem(branchB.work_item_id, {});
    expect(atF4!.position).toBe("f4");
  });
});
