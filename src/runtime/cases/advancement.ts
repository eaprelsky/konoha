/**
 * runtime/cases/advancement.ts — Case advancement state machine.
 * buildAdjacency, evalCondition, findJoinGateway, advanceCase, advancePastJoin,
 * sub-process spawning, join resolution.
 * Extracted from cases.ts (#507).
 */

import { randomUUID } from "crypto";
import { redis } from "../../redis";
import { publishEvent } from "../../redis";
import { getWorkflow, WORKFLOW_INDEX_KEY, type WorkflowDefinition, type WorkflowElement } from "../../workflow-loader";
import { assertCaseStartAllowed, type CaseStartGateOptions } from "../case-start-gate";
import { getAdapter } from "../../adapters/index";
import { dispatchWorkItem, isSystemDispatchRole } from "../../dispatcher";
import { createSubscriptionProgrammatic, cancelSubscriptionsByInstance, type TriggerDef } from "../../event-manager";
import { emitEvent } from "../event-log";
import { createLogger } from "../../logger";
import { createEventWait, loadActiveWaitsForCase } from "../event-waits";
import { scheduleWaitReminders } from "../event-waits";
import { enqueueWorkItemDispatchEffect } from "../workitem-dispatch-outbox";
import { saveCase, loadCase, saveWorkItem, loadWorkItem, CASES_IDX_PROCESS, WORKITEMS_IDX_CASE, WORKITEM_KEY_PREFIX } from "./persistence";
import type { Case, WorkItem, ActiveBranch } from "./types";
import { bindWorkflowSnapshotForCase, loadWorkflowForCase } from "./workflow-binding";
import { evalGatewayCondition } from "../../workflow-gateway-conditions";

const log = createLogger("runtime:advancement");
const WORKFLOW_KEY_PREFIX = "workflow:";
const MAX_LOOP_ITERATIONS = 200; // cycle detection guard

// ── Adjacency / condition helpers ────────────────────────────────────────────

export function buildAdjacency(def: WorkflowDefinition): {
  outEdges: Map<string, string[]>;
  inEdges: Map<string, string[]>;
  byId: Map<string, WorkflowElement>;
  edgeConditions: Map<string, string>;
} {
  const byId = new Map<string, WorkflowElement>(def.elements.map(e => [e.id, e]));
  const outEdges = new Map<string, string[]>();
  const inEdges = new Map<string, string[]>();
  const edgeConditions = new Map<string, string>();
  for (const el of def.elements) {
    outEdges.set(el.id, []);
    inEdges.set(el.id, []);
  }
  for (const edge of def.flow) {
    const [from, to, condition] = edge;
    outEdges.get(from)?.push(to);
    inEdges.get(to)?.push(from);
    if (condition) edgeConditions.set(`${from}->${to}`, condition);
  }
  return { outEdges, inEdges, byId, edgeConditions };
}

export function evalCondition(condition: string, payload: Record<string, unknown>): boolean {
  return evalGatewayCondition(condition, payload);
}

export function findJoinGateway(
  branchIds: string[],
  outEdges: Map<string, string[]>,
  byId: Map<string, WorkflowElement>,
): string | null {
  const reachableSets = branchIds.map(startId => {
    const visited = new Set<string>();
    const queue = [startId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const next of outEdges.get(id) || []) queue.push(next);
    }
    return visited;
  });
  if (reachableSets.length === 0) return null;
  for (const candidate of reachableSets[0]) {
    const el = byId.get(candidate);
    if (el?.type === "gateway" && reachableSets.every(r => r.has(candidate))) {
      return candidate;
    }
  }
  return null;
}

// ── Work item creation helpers ───────────────────────────────────────────────

async function createWorkItemForElement(
  kase: Case,
  elementId: string,
  el: WorkflowElement,
): Promise<WorkItem> {
  const now = new Date().toISOString();
  const wi: WorkItem = {
    work_item_id: randomUUID(),
    case_id: kase.case_id,
    process_id: kase.process_id,
    element_id: elementId,
    label: el.label,
    assignee: el.role || "unassigned",
    status: "pending",
    input: {
      ...kase.payload,
      ...(el.intent ? { _intent: el.intent } : {}),
    },
    created_at: now,
    updated_at: now,
  };
  await saveWorkItem(wi);
  await emitEvent({ type: "step.started", case_id: kase.case_id, process_id: kase.process_id, work_item_id: wi.work_item_id, element_id: elementId, label: el.label, timestamp: now });
  return wi;
}

async function dispatchWorkItemForElement(
  kase: Case,
  def: WorkflowDefinition,
  elementId: string,
  el: WorkflowElement,
  wi: WorkItem,
): Promise<void> {
  if (!el.role) return;
  const dispatchParams = {
    role: el.role,
    label: el.label,
    work_item_id: wi.work_item_id,
    case_id: kase.case_id,
    process_id: kase.process_id,
    element_id: elementId,
    docIds: el.documents || [],
    def,
    payload: kase.payload,
  };
  if (isSystemDispatchRole(el.role)) {
    await dispatchWorkItem(dispatchParams)
      .catch(e => log.error("system dispatch error", { case_id: kase.case_id, element_id: elementId, work_item_id: wi.work_item_id, error: e.message }));
  } else {
    await enqueueWorkItemDispatchEffect(dispatchParams)
      .catch(e => log.error("enqueue dispatch effect error", { case_id: kase.case_id, element_id: elementId, work_item_id: wi.work_item_id, error: e.message }));
  }
}

async function subscribeEventNode(kase: Case, el: WorkflowElement): Promise<void> {
  const trigger = el.trigger;
  if (!trigger?.kind || trigger.kind === "manual" || trigger.kind === "ambiguous" || trigger.manual_override) {
    return;
  }
  await createSubscriptionProgrammatic({
    event_id: el.id,
    process_id: kase.process_id,
    instance_id: kase.case_id,
    trigger: trigger as TriggerDef,
  });
}

// ── Sub-process resolution ───────────────────────────────────────────────────

async function resolveChildProcess(
  elementId: string,
  el: WorkflowElement,
  parentDef: WorkflowDefinition,
): Promise<string | null> {
  if (el.sub_process_id) return el.sub_process_id;
  log.warn("resolveChildProcess: sub_process_id missing, falling back to O(n) registry scan", {
    element_id: elementId, workflow_id: parentDef.id,
  });
  const allIds = await redis.smembers(WORKFLOW_INDEX_KEY);
  for (const id of allIds) {
    if (id === parentDef.id) continue;
    const raw = await redis.get(WORKFLOW_KEY_PREFIX + id);
    if (!raw) continue;
    const def: WorkflowDefinition = JSON.parse(raw);
    if (def.parent_id === parentDef.id && def.parent_function_id === elementId) {
      return def.id;
    }
  }
  return null;
}

async function completeParentWorkItem(childCase: Case): Promise<void> {
  if (!childCase.parent_work_item_id) return;
  const wi = await loadWorkItem(childCase.parent_work_item_id);
  if (!wi || wi.status === "done") return;

  const prevStatus = wi.status;
  wi.status = "done";
  wi.output = childCase.payload;
  wi.updated_at = new Date().toISOString();
  await saveWorkItem(wi, prevStatus);

  if (!wi.case_id) return;
  const parentCase = await loadCase(wi.case_id);
  if (!parentCase || parentCase.status !== "running") return;

  const parentDef = await loadWorkflowForCase(parentCase);
  if (!parentDef) return;

  parentCase.payload = { ...parentCase.payload, ...childCase.payload };
  const histEntry = parentCase.history.find(h => h.work_item_id === wi.work_item_id);
  if (histEntry) histEntry.output = childCase.payload;

  await advanceCase(parentCase, parentDef);
}

// ── Main advancement loop ────────────────────────────────────────────────────

export async function advanceCase(kase: Case, def: WorkflowDefinition): Promise<Case> {
  // Idempotency guard: only active cases may advance.
  if (kase.status !== "running") return kase;

  const { outEdges, inEdges, byId, edgeConditions } = buildAdjacency(def);

  let current = kase.position;
  let forcedNextId: string | null = null;
  let iterations = 0;

  while (true) {
    if (++iterations > MAX_LOOP_ITERATIONS) {
      log.error("cycle detected", { case_id: kase.case_id, process_id: kase.process_id, position: current, iterations });
      kase.status = "error";
      kase.active_branches = undefined;
      await cancelSubscriptionsByInstance(kase.case_id);
      await saveCase(kase);
      return kase;
    }
    // When current position is a gateway (e.g. start_node from trigger), evaluate it first.
    // Otherwise the loop skips to the first outgoing edge without checking conditions.
    if (forcedNextId === null) {
      const curEl = byId.get(current);
      if (curEl?.type === "gateway") {
        const gwOuts = outEdges.get(current) || [];
        const operator = curEl.operator;
        const gwTs = new Date().toISOString();
        kase.history.push({ element_id: current, element_type: "gateway", label: curEl.label, timestamp: gwTs });
        kase.position = current;
        await emitEvent({ type: "gateway.evaluated", case_id: kase.case_id, process_id: kase.process_id, element_id: current, label: curEl.label, timestamp: gwTs });

        if (operator === "XOR") {
          if (gwOuts.length === 0) { kase.status = "error"; await saveCase(kase); return kase; }
          if (gwOuts.length === 1) {
            const cond = edgeConditions.get(`${current}->${gwOuts[0]}`);
            if (cond && !evalCondition(cond, kase.payload)) {
              kase.status = "error";
              await saveCase(kase);
              return kase;
            }
            forcedNextId = gwOuts[0];
            continue;
          }
          let takenBranch: string | null = null;
          for (const outId of gwOuts) {
            const cond = edgeConditions.get(`${current}->${outId}`);
            if (!cond || evalCondition(cond, kase.payload)) {
              takenBranch = outId;
              break;
            }
          }
          if (!takenBranch) { kase.status = "error"; await saveCase(kase); return kase; }
          await saveCase(kase);
          forcedNextId = takenBranch;
          continue;
        }

        if (operator === "AND" || operator === "OR") {
          const gwIns = inEdges.get(current) || [];
          if (gwIns.length > 1) {
            // join gateway at current: pass through
            if (gwOuts.length === 0) { kase.status = "error"; await saveCase(kase); return kase; }
            await saveCase(kase);
            forcedNextId = gwOuts[0];
            continue;
          }
          // split gateway at current: create branches (same logic as below)
          let activeBranchIds: string[];
          if (operator === "AND") {
            activeBranchIds = gwOuts;
          } else {
            activeBranchIds = gwOuts.filter(outId => {
              const cond = edgeConditions.get(`${current}->${outId}`);
              return !cond || evalCondition(cond, kase.payload);
            });
            if (activeBranchIds.length === 0) { kase.status = "error"; await saveCase(kase); return kase; }
          }
          const branches: ActiveBranch[] = [];
          for (const branchStartId of activeBranchIds) {
            let branchEl = byId.get(branchStartId);
            let branchElId = branchStartId;
            while (branchEl?.type === "event") {
              kase.history.push({ element_id: branchElId, element_type: "event", label: branchEl.label, timestamp: new Date().toISOString() });
              const nextsOfBranch = outEdges.get(branchElId) || [];
              if (nextsOfBranch.length === 0) break;
              branchElId = nextsOfBranch[0];
              branchEl = byId.get(branchElId);
            }
            if (branchEl?.type !== "function") continue;
            const wi = await createWorkItemForElement(kase, branchElId, branchEl);
            kase.history.push({ element_id: branchElId, element_type: "function", label: branchEl.label, timestamp: wi.created_at, work_item_id: wi.work_item_id });
            await dispatchWorkItemForElement(kase, def, branchElId, branchEl, wi);
            const branchBindings = branchEl.systems ?? (branchEl.system ? [{ connector: branchEl.system, operation: "default" }] : []);
            if (branchBindings.length > 0) {
              const labelSlug = branchEl.label.toLowerCase().replace(/\s+/g, "_");
              let mergedOut: Record<string, unknown> = {};
              let branchErr = false;
              for (const binding of branchBindings) {
                const adapter = getAdapter(binding.connector);
                if (!adapter) continue;
                try {
                  const op = (binding.operation && binding.operation !== "default") ? binding.operation : labelSlug;
                  const out = await adapter.execute(op, kase.payload);
                  mergedOut = { ...mergedOut, ...out };
                } catch (e: any) {
                  log.error("adapter error in branch", { element_id: branchElId, error: e.message });
                  branchErr = true;
                  break;
                }
              }
              if (!branchErr && branchBindings.some(b => getAdapter(b.connector))) {
                wi.status = "done"; wi.output = mergedOut; wi.updated_at = new Date().toISOString();
                await saveWorkItem(wi, "pending");
                const h = kase.history.find(h => h.work_item_id === wi.work_item_id);
                if (h) h.output = mergedOut;
                branches.push({ element_id: branchElId, work_item_id: wi.work_item_id, done: true });
                continue;
              }
            }
            branches.push({ element_id: branchElId, work_item_id: wi.work_item_id, done: false });
          }
          kase.position = current;
          kase.active_branches = branches;
          kase.history.push({ element_id: current, element_type: "gateway", label: `${operator} split (${branches.length} branches)`, timestamp: new Date().toISOString() });
          await saveCase(kase);
          if (branches.length === 0 && activeBranchIds.length > 0) {
            const joinId = findJoinGateway(activeBranchIds, outEdges, byId);
            if (joinId) return advancePastJoin(kase, def, activeBranchIds);
            if (gwOuts.length > 0) { forcedNextId = gwOuts[0]; continue; }
            kase.status = "error"; await saveCase(kase); return kase;
          }
          if (branches.every(b => b.done)) return advancePastJoin(kase, def, branches.map(b => b.element_id));
          return kase;
        }

        kase.status = "error"; await saveCase(kase); return kase;
      }
    }

    let nextId: string;
    if (forcedNextId !== null) {
      nextId = forcedNextId;
      forcedNextId = null;
    } else {
      const nexts = outEdges.get(current) || [];

      if (nexts.length === 0) {
        const el = byId.get(current);
        if (el?.type === "event") {
          kase.status = "done";
          // Avoid duplicate history entry if already recorded during event auto-advance
          const lastEntry = kase.history[kase.history.length - 1];
          if (!lastEntry || lastEntry.element_id !== current) {
            kase.history.push({ element_id: current, element_type: "event", label: el.label, timestamp: new Date().toISOString() });
          }
          await saveCase(kase);
          cancelSubscriptionsByInstance(kase.case_id).catch(e =>
            log.error("subscription cleanup error", { case_id: kase.case_id, error: e.message }),
          );
          if (kase.parent_work_item_id) {
            void (async () => {
              const MAX_ATTEMPTS = 3;
              let delay = 500;
              for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                try {
                  await completeParentWorkItem(kase);
                  return;
                } catch (e: any) {
                  log.error("completeParentWorkItem error", { case_id: kase.case_id, error: e.message, attempt });
                  if (attempt < MAX_ATTEMPTS) {
                    await new Promise(r => setTimeout(r, delay));
                    delay *= 2;
                  }
                }
              }
              log.error("completeParentWorkItem failed after max retries", { case_id: kase.case_id });
              saveCase({ ...kase, needs_attention: true }).catch(e => log.error("saveCase needs_attention failed", { case_id: kase.case_id, error: e?.message }));
            })();
          }
          return kase;
        }
        kase.status = "error";
        await saveCase(kase);
        cancelSubscriptionsByInstance(kase.case_id).catch(e =>
          log.error("subscription cleanup error", { case_id: kase.case_id, error: e.message }),
        );
        publishEvent({ type: "process.exception", source: "runtime@comind.konoha", village_id: "comind.konoha", timestamp: new Date().toISOString(), payload: { case_id: kase.case_id, process_id: kase.process_id, error: `unexpected terminal element: ${current}` } }).catch(e => log.warn("publish process.exception failed", { error: e?.message }));
        return kase;
      }

      nextId = nexts[0];
    }

    const nextEl = byId.get(nextId);
    if (!nextEl) {
      kase.status = "error";
      await saveCase(kase);
      publishEvent({ type: "process.exception", source: "runtime@comind.konoha", village_id: "comind.konoha", timestamp: new Date().toISOString(), payload: { case_id: kase.case_id, process_id: kase.process_id, error: `element not found: ${nextId}` } }).catch(e => log.warn("publish process.exception failed", { error: e?.message }));
      return kase;
    }

    if (nextEl.type === "function") {
      const childProcessId = await resolveChildProcess(nextId, nextEl, def);

      if (childProcessId) {
        const wi = await createWorkItemForElement(kase, nextId, nextEl);
        kase.position = nextId;
        kase.history.push({ element_id: nextId, element_type: "function", label: nextEl.label, timestamp: wi.created_at, work_item_id: wi.work_item_id });
        await saveCase(kase);

        const childCase = await createCaseInner(
          childProcessId,
          `${kase.subject} → ${nextEl.label}`,
          { ...kase.payload },
          undefined,
          wi.work_item_id,
        );

        wi.child_case_id = childCase.case_id;
        await saveWorkItem(wi, "pending");

        if (childCase.status === "done") {
          const prevStatus = wi.status;
          wi.status = "done";
          wi.output = childCase.payload;
          wi.updated_at = new Date().toISOString();
          await saveWorkItem(wi, prevStatus);
          kase.payload = { ...kase.payload, ...childCase.payload };
          current = nextId;
          continue;
        }

        return kase;
      }

      const wi = await createWorkItemForElement(kase, nextId, nextEl);

      kase.position = nextId;
      kase.history.push({ element_id: nextId, element_type: "function", label: nextEl.label, timestamp: wi.created_at, work_item_id: wi.work_item_id });
      await saveCase(kase);

      await dispatchWorkItemForElement(kase, def, nextId, nextEl, wi);

      const systemBindings = nextEl.systems ?? (nextEl.system ? [{ connector: nextEl.system, operation: "default" }] : []);
      if (systemBindings.length > 0) {
        const labelSlug = nextEl.label.toLowerCase().replace(/\s+/g, "_");
        let mergedOutput: Record<string, unknown> = {};
        let adapterError = false;

        for (const binding of systemBindings) {
          const adapter = getAdapter(binding.connector);
          if (!adapter) continue;
          try {
            const op = (binding.operation && binding.operation !== "default") ? binding.operation : labelSlug;
            const out = await adapter.execute(op, kase.payload);
            mergedOutput = { ...mergedOutput, ...out };
          } catch (e: any) {
            log.error("adapter error", { connector: binding.connector, label: nextEl.label, error: e.message });
            adapterError = true;
            break;
          }
        }

        if (adapterError) {
          wi.status = "error";
          wi.updated_at = new Date().toISOString();
          await saveWorkItem(wi, "pending");
          kase.status = "error";
          await saveCase(kase);
          return kase;
        }

        if (Object.keys(mergedOutput).length > 0 || systemBindings.some(b => getAdapter(b.connector))) {
          const prevStatus = wi.status;
          wi.status = "done";
          wi.output = mergedOutput;
          wi.updated_at = new Date().toISOString();
          await saveWorkItem(wi, prevStatus);
          const histEntry = kase.history.find(h => h.work_item_id === wi.work_item_id);
          if (histEntry) histEntry.output = mergedOutput;
          current = nextId;
          continue;
        }
      }

      return kase;
    }

    if (nextEl.type === "event") {
      kase.position = nextId;
      kase.history.push({ element_id: nextId, element_type: "event", label: nextEl.label, timestamp: new Date().toISOString() });

      const isIntermediate = (inEdges.get(nextId) || []).length > 0 && (outEdges.get(nextId) || []).length > 0;
      const trigger = nextEl.trigger;
      const triggerKind = trigger?.kind || "manual";
      const shouldWait =
        isIntermediate &&
        Boolean(trigger?.kind || trigger?.manual_override);

      if (shouldWait) {
        const activeWaits = await loadActiveWaitsForCase(kase.case_id);
        let wait = activeWaits.find(w => w.element_id === nextId);
        if (!wait) {
          wait = await createEventWait({
            case_id: kase.case_id,
            process_id: kase.process_id,
            element_id: nextId,
            element_label: nextEl.label,
            trigger_kind: triggerKind as any,
            deadline: nextEl.trigger?.deadline,
            assignee: nextEl.role,
            escalation_target: nextEl.trigger?.escalation_target,
          });

          // Schedule reminders for manual waits (notification only, not process advancement)
          if (triggerKind === "manual" || trigger?.manual_override) {
            scheduleWaitReminders(wait).catch(e =>
              log.warn("failed to schedule wait reminders", { case_id: kase.case_id, element_id: nextId, error: e?.message }),
            );
          }
        }

        if (trigger?.kind && trigger.kind !== "manual" && trigger.kind !== "ambiguous" && !trigger.manual_override) {
          await saveCase(kase);
          subscribeEventNode(kase, nextEl).catch(e =>
            log.error("intermediate event subscribe error", { case_id: kase.case_id, node_id: nextId, error: e.message }),
          );
          return kase;
        }
        if (trigger?.kind) {
          await saveCase(kase);
          return kase;
        }
      }

      current = nextId;
      continue;
    }

    if (nextEl.type === "gateway") {
      const operator = nextEl.operator;
      const gwOuts = outEdges.get(nextId) || [];

      if (operator === "XOR") {
        const gwTs = new Date().toISOString();
        kase.history.push({ element_id: nextId, element_type: "gateway", label: nextEl.label, timestamp: gwTs });
        kase.position = nextId;
        await emitEvent({ type: "gateway.evaluated", case_id: kase.case_id, process_id: kase.process_id, element_id: nextId, label: nextEl.label, timestamp: gwTs });

        if (gwOuts.length <= 1) {
          if (gwOuts.length === 0) { kase.status = "error"; await saveCase(kase); return kase; }
          const cond = edgeConditions.get(`${nextId}->${gwOuts[0]}`);
          if (cond && !evalCondition(cond, kase.payload)) {
            kase.status = "error";
            await saveCase(kase);
            return kase;
          }
          current = nextId;
          forcedNextId = gwOuts[0];
          continue;
        }

        let takenBranch: string | null = null;
        for (const outId of gwOuts) {
          const cond = edgeConditions.get(`${nextId}->${outId}`);
          if (!cond || evalCondition(cond, kase.payload)) {
            takenBranch = outId;
            break;
          }
        }
        if (!takenBranch) { kase.status = "error"; await saveCase(kase); return kase; }
        await saveCase(kase);
        current = nextId;
        forcedNextId = takenBranch;
        continue;
      }

      if (operator === "AND" || operator === "OR") {
        // JOIN detection: gateways with multiple incoming edges are merge/join
        // points, not splits. Pass through to outgoing edges.
        const gwIns = inEdges.get(nextId) || [];
        if (gwIns.length > 1) {
          kase.position = nextId;
          kase.history.push({ element_id: nextId, element_type: "gateway", label: nextEl.label, timestamp: new Date().toISOString() });
          await saveCase(kase);
          if (gwOuts.length === 0) {
            kase.status = "error";
            await saveCase(kase);
            return kase;
          }
          current = nextId;
          continue;
        }

        let activeBranchIds: string[];
        if (operator === "AND") {
          activeBranchIds = gwOuts;
        } else {
          activeBranchIds = gwOuts.filter(outId => {
            const cond = edgeConditions.get(`${nextId}->${outId}`);
            return !cond || evalCondition(cond, kase.payload);
          });
          if (activeBranchIds.length === 0) { kase.status = "error"; await saveCase(kase); return kase; }
        }

        const branches: ActiveBranch[] = [];
        for (const branchStartId of activeBranchIds) {
          let branchEl = byId.get(branchStartId);
          let branchElId = branchStartId;
          while (branchEl?.type === "event") {
            kase.history.push({ element_id: branchElId, element_type: "event", label: branchEl.label, timestamp: new Date().toISOString() });
            const nextsOfBranch = outEdges.get(branchElId) || [];
            if (nextsOfBranch.length === 0) break;
            branchElId = nextsOfBranch[0];
            branchEl = byId.get(branchElId);
          }
          if (branchEl?.type !== "function") continue;

          const wi = await createWorkItemForElement(kase, branchElId, branchEl);
          kase.history.push({ element_id: branchElId, element_type: "function", label: branchEl.label, timestamp: wi.created_at, work_item_id: wi.work_item_id });
          await dispatchWorkItemForElement(kase, def, branchElId, branchEl, wi);

          const branchBindings = branchEl.systems ?? (branchEl.system ? [{ connector: branchEl.system, operation: "default" }] : []);
          if (branchBindings.length > 0) {
            const labelSlug = branchEl.label.toLowerCase().replace(/\s+/g, "_");
            let mergedOut: Record<string, unknown> = {};
            let branchErr = false;
            for (const binding of branchBindings) {
              const adapter = getAdapter(binding.connector);
              if (!adapter) continue;
              try {
                const op = (binding.operation && binding.operation !== "default") ? binding.operation : labelSlug;
                const out = await adapter.execute(op, kase.payload);
                mergedOut = { ...mergedOut, ...out };
              } catch (e: any) {
                log.error("adapter error in branch", { element_id: branchElId, error: e.message });
                branchErr = true;
                break;
              }
            }
            if (!branchErr && branchBindings.some(b => getAdapter(b.connector))) {
              wi.status = "done"; wi.output = mergedOut; wi.updated_at = new Date().toISOString();
              await saveWorkItem(wi, "pending");
              const h = kase.history.find(h => h.work_item_id === wi.work_item_id);
              if (h) h.output = mergedOut;
              branches.push({ element_id: branchElId, work_item_id: wi.work_item_id, done: true });
              continue;
            }
          }
          branches.push({ element_id: branchElId, work_item_id: wi.work_item_id, done: false });
        }

        kase.position = nextId;
        kase.active_branches = branches;
        kase.history.push({ element_id: nextId, element_type: "gateway", label: `${operator} split (${branches.length} branches)`, timestamp: new Date().toISOString() });
        await saveCase(kase);

        if (branches.length === 0 && activeBranchIds.length > 0) {
          const joinId = findJoinGateway(activeBranchIds, outEdges, byId);
          if (joinId) {
            return advancePastJoin(kase, def, activeBranchIds);
          }
          if (gwOuts.length > 0) {
            current = nextId;
            continue;
          }
          kase.status = "error";
          await saveCase(kase);
          return kase;
        }

        if (branches.every(b => b.done)) {
          return advancePastJoin(kase, def, branches.map(b => b.element_id));
        }
        return kase;
      }

      kase.status = "error";
      await saveCase(kase);
      return kase;
    }

    kase.status = "error";
    await saveCase(kase);
    return kase;
  }
}

export async function advancePastJoin(kase: Case, def: WorkflowDefinition, branchElementIds: string[]): Promise<Case> {
  const { outEdges, byId } = buildAdjacency(def);
  const joinId = findJoinGateway(branchElementIds, outEdges, byId);

  kase.active_branches = undefined;
  kase.history.push({ element_id: joinId || "(join)", element_type: "gateway", label: "join", timestamp: new Date().toISOString() });

  if (!joinId) {
    kase.status = "error";
    await saveCase(kase);
    return kase;
  }

  kase.position = joinId;
  await saveCase(kase);
  return advanceCase(kase, def);
}

// ── Inner createCase (used by advanceCase for sub-process spawning) ──────────

export async function createCaseInner(
  process_id: string,
  subject: string,
  payload: Record<string, unknown> = {},
  start_node?: string,
  parentWorkItemId?: string,
  options: CaseStartGateOptions = {},
): Promise<Case> {
  let def = await getWorkflow(process_id);
  if (!def) {
    await new Promise(r => setTimeout(r, 200));
    def = await getWorkflow(process_id);
  }
  if (!def) throw new Error(`Workflow "${process_id}" not found in registry`);
  await assertCaseStartAllowed(def, options);

  let startId = start_node;
  if (!startId) {
    const { inEdges } = buildAdjacency(def);
    const startEl = def.elements.find(el => (inEdges.get(el.id) || []).length === 0 && el.type === "event");
    if (!startEl) throw new Error(`Workflow "${process_id}" has no start event`);
    startId = startEl.id;
  }

  const startEl = def.elements.find(e => e.id === startId);
  if (!startEl) throw new Error(`Start node "${startId}" not found in workflow "${process_id}"`);
  const workflowSnapshot = await bindWorkflowSnapshotForCase(def);
  const runtimeDef = await loadWorkflowForCase({ process_id, workflow_snapshot: workflowSnapshot }) ?? def;

  const case_id = randomUUID();
  const now = new Date().toISOString();

  let parentCaseId: string | undefined;
  if (parentWorkItemId) {
    const parentWI = await loadWorkItem(parentWorkItemId);
    parentCaseId = parentWI?.case_id ?? undefined;
  }

  const kase: Case = {
    case_id,
    process_id,
    process_version: def.version,
    workflow_snapshot: workflowSnapshot,
    subject,
    status: "running",
    position: startId,
    payload,
    history: [{ element_id: startId, element_type: startEl.type, label: startEl.label, timestamp: now }],
    created_at: now,
    ...(parentWorkItemId ? { parent_work_item_id: parentWorkItemId, parent_case_id: parentCaseId } : {}),
  };

  await saveCase(kase);
  await emitEvent({ type: "case.created", case_id: kase.case_id, process_id: kase.process_id, timestamp: kase.created_at });
  return advanceCase(kase, runtimeDef);
}
