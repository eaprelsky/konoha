/**
 * intent-decomposer.ts — High-level intent to action sequence mapping (#503)
 *
 * Translates user intents (e.g. "add approval step") into ordered sequences
 * of act-envelope actions. The assistant can express changes as high-level
 * intents instead of raw patch-level mutations.
 *
 * Usage:
 *   const plan = decomposeIntent("add_approval_step", { after: "func_1", label: "Согласование", role: "manager" });
 *   // → [element.add, flow.add, flow.remove_old_if_any]
 *
 * Each intent produces an array of ActEnvelope objects that can be
 * executed sequentially via the /act endpoint.
 */

import { classifyAction } from "./act-envelope";
import type { ActEnvelope } from "./act-envelope";

// ── Intent types ──────────────────────────────────────────────────────────────

export interface IntentDef {
  /** Unique intent ID */
  id: string;
  /** Human description */
  description: string;
  /** Required parameters for this intent */
  params: string[];
  /** Whether this intent produces an ordered action sequence */
  compound: boolean;
}

export interface DecomposedAction {
  /** Action envelope to execute */
  envelope: ActEnvelope;
  /** Human description of what this step does */
  description: string;
  /** Order in the sequence (0-based) */
  order: number;
}

export interface DecomposedPlan {
  intent: string;
  actions: DecomposedAction[];
  /** Estimated side effects for audit */
  side_effects: string[];
}

// ── Intent registry ───────────────────────────────────────────────────────────

const INTENTS: IntentDef[] = [
  {
    id: "add_approval_step",
    description: "Add a manual approval event after a function node",
    params: ["workflow_id", "after_element", "label", "role"],
    compound: true,
  },
  {
    id: "add_timer_start",
    description: "Add a timer-triggered start event to a process",
    params: ["workflow_id", "cron", "label"],
    compound: true,
  },
  {
    id: "add_condition_branch",
    description: "Add a conditional gateway with two branches",
    params: ["workflow_id", "after_element", "condition", "true_label", "false_label"],
    compound: true,
  },
  {
    id: "confirm_manual_event",
    description: "Confirm a pending manual event wait",
    params: ["case_id", "confirmed_by"],
    compound: false,
  },
  {
    id: "replace_event_trigger",
    description: "Replace an event node's trigger with a new kind",
    params: ["workflow_id", "element_id", "kind", "config"],
    compound: true,
  },
  {
    id: "add_subprocess",
    description: "Add a function node that calls a sub-process",
    params: ["workflow_id", "after_element", "label", "sub_process_id"],
    compound: true,
  },
];

// ── Decomposition logic ───────────────────────────────────────────────────────

export function decomposeIntent(
  intentId: string,
  params: Record<string, unknown>,
): DecomposedPlan | null {
  const intent = INTENTS.find(i => i.id === intentId);
  if (!intent) return null;

  // Check required params
  for (const p of intent.params) {
    if (params[p] === undefined) {
      return {
        intent: intentId,
        actions: [],
        side_effects: [`Missing required parameter: ${p}`],
      };
    }
  }

  switch (intentId) {
    case "add_approval_step":
      return decomposeAddApprovalStep(params);
    case "add_timer_start":
      return decomposeAddTimerStart(params);
    case "add_condition_branch":
      return decomposeAddConditionBranch(params);
    case "confirm_manual_event":
      return decomposeConfirmManualEvent(params);
    case "replace_event_trigger":
      return decomposeReplaceTrigger(params);
    case "add_subprocess":
      return decomposeAddSubprocess(params);
    default:
      return null;
  }
}

export function listIntents(): IntentDef[] {
  return [...INTENTS];
}

export function getIntent(id: string): IntentDef | undefined {
  return INTENTS.find(i => i.id === id);
}

// ── Individual decomposers ───────────────────────────────────────────────────

function elementId(): string {
  return `el_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function decomposeAddApprovalStep(params: Record<string, unknown>): DecomposedPlan {
  const evtId = elementId();
  const afterEl = String(params.after_element);
  const label = String(params.label);
  const role = String(params.role);
  const wfId = String(params.workflow_id);

  return {
    intent: "add_approval_step",
    actions: [
      {
        order: 0,
        description: `Add manual event node "${label}"`,
        envelope: {
          action: "element.add",
          category: "act",
          args: {
            workflow_id: wfId,
            id: evtId,
            type: "event",
            label,
            role,
            trigger: { kind: "manual", action: "approve", role },
          },
        },
      },
      {
        order: 1,
        description: `Connect "${afterEl}" → "${evtId}"`,
        envelope: {
          action: "flow.add",
          category: "act",
          args: { workflow_id: wfId, from: afterEl, to: evtId },
        },
      },
    ],
    side_effects: [
      `Manual event "${label}" will require approval by ${role}`,
      "Process will pause at this node until confirmed",
      "Overdue escalation will trigger if deadline is set",
    ],
  };
}

function decomposeAddTimerStart(params: Record<string, unknown>): DecomposedPlan {
  const evtId = elementId();
  const cron = String(params.cron);
  const label = String(params.label);
  const wfId = String(params.workflow_id);

  return {
    intent: "add_timer_start",
    actions: [
      {
        order: 0,
        description: `Add timer event "${label}" with cron "${cron}"`,
        envelope: {
          action: "element.add",
          category: "act",
          args: {
            workflow_id: wfId,
            id: evtId,
            type: "event",
            label,
            trigger: { kind: "timer", cron },
          },
        },
      },
      {
        order: 1,
        description: `Set trigger for "${label}"`,
        envelope: {
          action: "trigger.set",
          category: "act",
          args: {
            workflow_id: wfId,
            element_id: evtId,
            kind: "timer",
            config: { cron },
          },
        },
      },
    ],
    side_effects: [
      `Timer will fire on schedule: ${cron}`,
      "Each firing will create a new case instance",
      "Redeploy required to activate subscription",
    ],
  };
}

function decomposeAddConditionBranch(params: Record<string, unknown>): DecomposedPlan {
  const gwId = elementId();
  const trueId = elementId();
  const falseId = elementId();
  const afterEl = String(params.after_element);
  const condition = String(params.condition);
  const trueLabel = String(params.true_label);
  const falseLabel = String(params.false_label);
  const wfId = String(params.workflow_id);

  return {
    intent: "add_condition_branch",
    actions: [
      {
        order: 0,
        description: `Add XOR gateway`,
        envelope: {
          action: "element.add",
          category: "act",
          args: { workflow_id: wfId, id: gwId, type: "gateway", label: "Условие", operator: "XOR" },
        },
      },
      {
        order: 1,
        description: `Connect "${afterEl}" → gateway`,
        envelope: {
          action: "flow.add",
          category: "act",
          args: { workflow_id: wfId, from: afterEl, to: gwId },
        },
      },
      {
        order: 2,
        description: `Add true branch "${trueLabel}"`,
        envelope: {
          action: "element.add",
          category: "act",
          args: { workflow_id: wfId, id: trueId, type: "function", label: trueLabel },
        },
      },
      {
        order: 3,
        description: `Add false branch "${falseLabel}"`,
        envelope: {
          action: "element.add",
          category: "act",
          args: { workflow_id: wfId, id: falseId, type: "function", label: falseLabel },
        },
      },
      {
        order: 4,
        description: `Connect gateway → true branch with condition`,
        envelope: {
          action: "flow.add",
          category: "act",
          args: { workflow_id: wfId, from: gwId, to: trueId, condition },
        },
      },
      {
        order: 5,
        description: `Connect gateway → false branch`,
        envelope: {
          action: "flow.add",
          category: "act",
          args: { workflow_id: wfId, from: gwId, to: falseId },
        },
      },
    ],
    side_effects: [
      `XOR branching on: ${condition}`,
      "Both branches must converge at a join gateway later",
    ],
  };
}

function decomposeConfirmManualEvent(params: Record<string, unknown>): DecomposedPlan {
  return {
    intent: "confirm_manual_event",
    actions: [
      {
        order: 0,
        description: "Confirm the pending manual event",
        envelope: {
          action: "event.confirm",
          category: "act",
          args: {
            case_id: params.case_id,
            element_id: params.element_id,
            comment: params.comment,
            confirmed_by: params.confirmed_by,
            outcome: params.outcome,
          },
        },
      },
    ],
    side_effects: [
      "Case will advance past the confirmed event node",
      "EventWait status will change to 'fired'",
      "Audit event 'event.confirmed' will be emitted",
    ],
  };
}

function decomposeReplaceTrigger(params: Record<string, unknown>): DecomposedPlan {
  const wfId = String(params.workflow_id);
  const elId = String(params.element_id);
  const kind = String(params.kind);

  return {
    intent: "replace_event_trigger",
    actions: [
      {
        order: 0,
        description: `Update element trigger to "${kind}"`,
        envelope: {
          action: "element.update",
          category: "act",
          args: {
            workflow_id: wfId,
            id: elId,
            trigger: { kind, ...((params.config as Record<string, unknown>) ?? {}) },
          },
        },
      },
      {
        order: 1,
        description: `Set explicit trigger config`,
        envelope: {
          action: "trigger.set",
          category: "act",
          args: {
            workflow_id: wfId,
            element_id: elId,
            kind,
            config: params.config,
          },
        },
      },
    ],
    side_effects: [
      `Trigger changed to ${kind} — redeploy required`,
      "Old subscription will be cancelled on next deploy",
      "New subscription will be created for the updated trigger",
    ],
  };
}

function decomposeAddSubprocess(params: Record<string, unknown>): DecomposedPlan {
  const fnId = elementId();
  const afterEl = String(params.after_element);
  const label = String(params.label);
  const subProcessId = String(params.sub_process_id);
  const wfId = String(params.workflow_id);

  return {
    intent: "add_subprocess",
    actions: [
      {
        order: 0,
        description: `Add function "${label}" with sub-process ref`,
        envelope: {
          action: "element.add",
          category: "act",
          args: {
            workflow_id: wfId,
            id: fnId,
            type: "function",
            label,
            sub_process_id: subProcessId,
          },
        },
      },
      {
        order: 1,
        description: `Connect "${afterEl}" → "${fnId}"`,
        envelope: {
          action: "flow.add",
          category: "act",
          args: { workflow_id: wfId, from: afterEl, to: fnId },
        },
      },
    ],
    side_effects: [
      `Function will spawn sub-process "${subProcessId}" as a child case`,
      "Parent case pauses until child completes",
      "Child case output merges into parent payload",
    ],
  };
}
