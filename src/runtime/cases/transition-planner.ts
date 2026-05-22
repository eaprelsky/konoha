import type { WorkflowDefinition, WorkflowElement } from "../../workflow-loader";
import { evalGatewayCondition } from "../../workflow-gateway-conditions";
import type { Case, HistoryEntry } from "./types";

export interface GraphAdjacency {
  outEdges: Map<string, string[]>;
  inEdges: Map<string, string[]>;
  byId: Map<string, WorkflowElement>;
  edgeConditions: Map<string, string>;
}

export type GraphTransitionEffectIntent =
  | { kind: "gateway.evaluated"; element_id: string; label: string }
  | { kind: "function.work_item"; element_id: string; label: string }
  | { kind: "event.wait"; element_id: string; label: string; trigger_kind: string; subscribe: boolean; schedule_reminders: boolean }
  | { kind: "case.complete"; element_id: string }
  | { kind: "case.error"; element_id: string; reason: string };

export interface PlannedBranchWorkItem {
  branch_start_id: string;
  element_id: string;
  element: WorkflowElement;
  skipped_history: Omit<HistoryEntry, "timestamp">[];
}

export type GraphTransitionPlan =
  | { kind: "inactive"; effects: GraphTransitionEffectIntent[] }
  | { kind: "continue"; position: string; history: Omit<HistoryEntry, "timestamp">[]; next_current: string; forced_next_id?: string; effects: GraphTransitionEffectIntent[] }
  | { kind: "function"; position: string; element_id: string; element: WorkflowElement; history: Omit<HistoryEntry, "timestamp">[]; effects: GraphTransitionEffectIntent[] }
  | { kind: "event_wait"; position: string; element_id: string; element: WorkflowElement; history: Omit<HistoryEntry, "timestamp">[]; trigger_kind: string; subscribe: boolean; schedule_reminders: boolean; effects: GraphTransitionEffectIntent[] }
  | { kind: "gateway_split"; position: string; gateway_id: string; gateway: WorkflowElement; operator: "AND" | "OR"; active_branch_ids: string[]; branch_work_items: PlannedBranchWorkItem[]; history: Omit<HistoryEntry, "timestamp">[]; split_history: Omit<HistoryEntry, "timestamp">; effects: GraphTransitionEffectIntent[]; empty_branch_join_id?: string; empty_branch_next_id?: string }
  | { kind: "complete"; position: string; history: Omit<HistoryEntry, "timestamp">[]; effects: GraphTransitionEffectIntent[] }
  | { kind: "error"; position: string; reason: string; history: Omit<HistoryEntry, "timestamp">[]; effects: GraphTransitionEffectIntent[] };

export interface PlanGraphTransitionInput {
  workflow: WorkflowDefinition;
  case: Pick<Case, "status" | "position" | "payload" | "history">;
  adjacency?: GraphAdjacency;
  current?: string;
  forced_next_id?: string | null;
}

export function buildGraphAdjacency(def: WorkflowDefinition): GraphAdjacency {
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

export function evaluateGraphCondition(condition: string, payload: Record<string, unknown>): boolean {
  return evalGatewayCondition(condition, payload);
}

export function findGraphJoinGateway(
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

export function planGraphTransition(input: PlanGraphTransitionInput): GraphTransitionPlan {
  const kase = input.case;
  if (kase.status !== "running") return { kind: "inactive", effects: [] };

  const adjacency = input.adjacency ?? buildGraphAdjacency(input.workflow);
  const current = input.current ?? kase.position;

  if (input.forced_next_id) {
    return planElementArrival(input.forced_next_id, adjacency, kase.payload);
  }

  const curEl = adjacency.byId.get(current);
  if (curEl?.type === "gateway") {
    return planGateway(current, curEl, adjacency, kase.payload);
  }

  const nexts = adjacency.outEdges.get(current) || [];
  if (nexts.length === 0) {
    if (curEl?.type === "event") {
      const history = lastHistoryElementId(kase) === current
        ? []
        : [historyEntry(current, "event", curEl.label)];
      return {
        kind: "complete",
        position: current,
        history,
        effects: [{ kind: "case.complete", element_id: current }],
      };
    }
    return errorPlan(current, `unexpected terminal element: ${current}`);
  }

  return planElementArrival(nexts[0], adjacency, kase.payload);
}

function planElementArrival(
  elementId: string,
  adjacency: GraphAdjacency,
  payload: Record<string, unknown>,
): GraphTransitionPlan {
  const el = adjacency.byId.get(elementId);
  if (!el) return errorPlan(elementId, `element not found: ${elementId}`);

  if (el.type === "function") {
    return {
      kind: "function",
      position: elementId,
      element_id: elementId,
      element: el,
      history: [historyEntry(elementId, "function", el.label)],
      effects: [{ kind: "function.work_item", element_id: elementId, label: el.label }],
    };
  }

  if (el.type === "event") {
    const isIntermediate = (adjacency.inEdges.get(elementId) || []).length > 0 && (adjacency.outEdges.get(elementId) || []).length > 0;
    const trigger = el.trigger;
    const triggerKind = trigger?.kind || "manual";
    const shouldWait = isIntermediate && Boolean(trigger?.kind || trigger?.manual_override);
    const history = [historyEntry(elementId, "event", el.label)];

    if (shouldWait) {
      const subscribe = Boolean(trigger?.kind && trigger.kind !== "manual" && trigger.kind !== "ambiguous" && !trigger.manual_override);
      const scheduleReminders = triggerKind === "manual" || Boolean(trigger?.manual_override);
      return {
        kind: "event_wait",
        position: elementId,
        element_id: elementId,
        element: el,
        history,
        trigger_kind: triggerKind,
        subscribe,
        schedule_reminders: scheduleReminders,
        effects: [{ kind: "event.wait", element_id: elementId, label: el.label, trigger_kind: triggerKind, subscribe, schedule_reminders: scheduleReminders }],
      };
    }

    return {
      kind: "continue",
      position: elementId,
      history,
      next_current: elementId,
      effects: [],
    };
  }

  if (el.type === "gateway") {
    return planGateway(elementId, el, adjacency, payload);
  }

  return errorPlan(elementId, `unsupported element type at ${elementId}`);
}

function planGateway(
  gatewayId: string,
  gateway: WorkflowElement,
  adjacency: GraphAdjacency,
  payload: Record<string, unknown>,
): GraphTransitionPlan {
  const operator = gateway.operator;
  const gwOuts = adjacency.outEdges.get(gatewayId) || [];
  const gatewayHistory = historyEntry(gatewayId, "gateway", gateway.label);
  const effects: GraphTransitionEffectIntent[] = [{ kind: "gateway.evaluated", element_id: gatewayId, label: gateway.label }];

  if (operator === "XOR") {
    if (gwOuts.length === 0) return errorPlan(gatewayId, `gateway ${gatewayId} has no outgoing branches`, [gatewayHistory], effects);
    if (gwOuts.length === 1) {
      const cond = adjacency.edgeConditions.get(`${gatewayId}->${gwOuts[0]}`);
      if (cond && !evaluateGraphCondition(cond, payload)) {
        return errorPlan(gatewayId, `gateway ${gatewayId} condition did not match`, [gatewayHistory], effects);
      }
      return {
        kind: "continue",
        position: gatewayId,
        history: [gatewayHistory],
        next_current: gatewayId,
        forced_next_id: gwOuts[0],
        effects,
      };
    }
    const takenBranch = gwOuts.find(outId => {
      const cond = adjacency.edgeConditions.get(`${gatewayId}->${outId}`);
      return !cond || evaluateGraphCondition(cond, payload);
    });
    if (!takenBranch) return errorPlan(gatewayId, `gateway ${gatewayId} has no matching branch`, [gatewayHistory], effects);
    return {
      kind: "continue",
      position: gatewayId,
      history: [gatewayHistory],
      next_current: gatewayId,
      forced_next_id: takenBranch,
      effects,
    };
  }

  if (operator === "AND" || operator === "OR") {
    const gwIns = adjacency.inEdges.get(gatewayId) || [];
    if (gwIns.length > 1) {
      if (gwOuts.length === 0) return errorPlan(gatewayId, `join gateway ${gatewayId} has no outgoing branch`, [gatewayHistory], effects);
      return {
        kind: "continue",
        position: gatewayId,
        history: [gatewayHistory],
        next_current: gatewayId,
        forced_next_id: gwOuts[0],
        effects,
      };
    }

    const activeBranchIds = operator === "AND"
      ? gwOuts
      : gwOuts.filter(outId => {
          const cond = adjacency.edgeConditions.get(`${gatewayId}->${outId}`);
          return !cond || evaluateGraphCondition(cond, payload);
        });
    if (operator === "OR" && activeBranchIds.length === 0) {
      return errorPlan(gatewayId, `gateway ${gatewayId} has no matching branch`, [gatewayHistory], effects);
    }

    const branchWorkItems = activeBranchIds
      .map(branchStartId => planBranchWorkItem(branchStartId, adjacency))
      .filter((branch): branch is PlannedBranchWorkItem => branch !== null);
    return {
      kind: "gateway_split",
      position: gatewayId,
      gateway_id: gatewayId,
      gateway,
      operator,
      active_branch_ids: activeBranchIds,
      branch_work_items: branchWorkItems,
      history: [gatewayHistory],
      split_history: historyEntry(gatewayId, "gateway", `${operator} split (${branchWorkItems.length} branches)`),
      effects,
      ...(branchWorkItems.length === 0 && activeBranchIds.length > 0
        ? {
            empty_branch_join_id: findGraphJoinGateway(activeBranchIds, adjacency.outEdges, adjacency.byId) ?? undefined,
            empty_branch_next_id: gwOuts[0],
          }
        : {}),
    };
  }

  return errorPlan(gatewayId, `unsupported gateway operator at ${gatewayId}`, [gatewayHistory], effects);
}

function planBranchWorkItem(branchStartId: string, adjacency: GraphAdjacency): PlannedBranchWorkItem | null {
  const skippedHistory: Omit<HistoryEntry, "timestamp">[] = [];
  let branchElId = branchStartId;
  let branchEl = adjacency.byId.get(branchElId);
  while (branchEl?.type === "event") {
    skippedHistory.push(historyEntry(branchElId, "event", branchEl.label));
    const nextsOfBranch = adjacency.outEdges.get(branchElId) || [];
    if (nextsOfBranch.length === 0) break;
    branchElId = nextsOfBranch[0];
    branchEl = adjacency.byId.get(branchElId);
  }
  if (branchEl?.type !== "function") return null;
  return {
    branch_start_id: branchStartId,
    element_id: branchElId,
    element: branchEl,
    skipped_history: skippedHistory,
  };
}

function historyEntry(element_id: string, element_type: string, label: string): Omit<HistoryEntry, "timestamp"> {
  return { element_id, element_type, label };
}

function lastHistoryElementId(kase: Pick<Case, "history">): string | undefined {
  return kase.history[kase.history.length - 1]?.element_id;
}

function errorPlan(
  position: string,
  reason: string,
  history: Omit<HistoryEntry, "timestamp">[] = [],
  effects: GraphTransitionEffectIntent[] = [],
): GraphTransitionPlan {
  return {
    kind: "error",
    position,
    reason,
    history,
    effects: [...effects, { kind: "case.error", element_id: position, reason }],
  };
}
