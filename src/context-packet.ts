/**
 * context-packet.ts — Execution context packet for a process step (#502)
 *
 * When the workflow engine reaches a function node and creates a work item,
 * it assembles a formal context packet with everything the executor needs:
 *   - Step description and intent
 *   - Role assignment and executor contract
 *   - Case data (payload, history)
 *   - Documents and artifacts
 *   - System bindings
 *   - Constraints and restrictions
 *   - Expected output
 *
 * The packet is suitable for both human and agent executors, and can be
 * rendered by a future workbench UI.
 *
 * Built on top of:
 *   - Action registry (#499)
 *   - Act envelope (#500)
 *   - Executor contract (#501)
 */

import type { WorkflowElement, WorkflowDefinition, FlowEdge } from "./workflow-loader";
import type { RoleContract } from "./executor-contract";
import type { Case, HistoryEntry } from "./runtime/cases/types";
import type { WorkItem } from "./runtime/cases/types";

// ── Context packet types ─────────────────────────────────────────────────────

export interface ContextPacket {
  /** Packet schema version */
  version: 1;

  // ── Identification ───────────────────────────────────────────────────────
  /** Unique packet ID (same as work_item_id) */
  packet_id: string;
  /** When this packet was assembled */
  assembled_at: string;

  // ── Process context ──────────────────────────────────────────────────────
  process: ProcessContext;
  /** The specific step this packet is for */
  step: StepContext;

  // ── Assignment ───────────────────────────────────────────────────────────
  assignment: AssignmentContext;

  // ── Data ─────────────────────────────────────────────────────────────────
  /** Current case data (mutable — executor can read and write) */
  case_data: CaseDataContext;
  /** Available documents and instructions */
  documents: DocumentRef[];
  /** System bindings and their current state */
  systems: SystemBindingContext[];
  /** Artifacts from previous steps */
  artifacts: ArtifactRef[];

  // ── Constraints ──────────────────────────────────────────────────────────
  constraints: ExecutionConstraints;

  // ── Expected output ──────────────────────────────────────────────────────
  expected_output: ExpectedOutput;
}

// ── Sub-structures ───────────────────────────────────────────────────────────

export interface ProcessContext {
  /** Process definition ID */
  process_id: string;
  /** Process version */
  process_version: string;
  /** Human-readable process name */
  process_name: string;
  /** Case ID (running instance) */
  case_id: string;
  /** Case subject / title */
  case_subject: string;
}

export interface StepContext {
  /** Element ID in the workflow */
  element_id: string;
  /** Step label / title */
  label: string;
  /** Optional intent (outcome-based description for AI agents) */
  intent?: string;
  /** Element type (always "function" for executable steps) */
  element_type: "function";
  /** Position in the process flow */
  position: StepPosition;
  /** Instruction text (from document nodes attached to this step) */
  instruction?: string;
}

export interface StepPosition {
  /** Previous step(s) in the flow */
  predecessors: Array<{ id: string; label: string; type: string }>;
  /** Next step(s) in the flow */
  successors: Array<{ id: string; label: string; type: string }>;
  /** Branch info (if inside an AND/OR split) */
  branch?: string;
}

export interface AssignmentContext {
  /** Role assigned to this step */
  role: string;
  /** Executor contract for the role */
  executor_contract?: RoleContract;
  /** Assigned executor (if resolved) */
  assignee?: string;
  /** Assignment strategy used */
  strategy?: string;
  /** Dispatch deadline (from SLA config) */
  deadline?: string;
}

export interface CaseDataContext {
  /** Current payload (key-value pairs carried through the case) */
  payload: Record<string, unknown>;
  /** Recent history entries (last N steps) */
  recent_history: HistoryEntry[];
  /** Case status */
  status: string;
  /** Case creation time */
  created_at: string;
}

export interface DocumentRef {
  /** Document ID */
  id: string;
  /** Document title */
  title?: string;
  /** Content type: instruction text or file reference */
  type: "instruction" | "file";
  /** Content (for inline instructions) */
  content?: string;
  /** File path (for file references) */
  file_ref?: string;
}

export interface SystemBindingContext {
  /** Adapter/connector name (e.g. "bitrix24", "telegram") */
  connector: string;
  /** Specific operation (defaults to function label slug) */
  operation?: string;
  /** Adapter health status */
  healthy?: boolean;
}

export interface ArtifactRef {
  /** Artifact name */
  name: string;
  /** Source step that produced this artifact */
  source_element_id: string;
  /** Source step label */
  source_label: string;
  /** Artifact data */
  data: unknown;
  /** When it was produced */
  produced_at: string;
}

export interface ExecutionConstraints {
  /** Maximum time allowed for this step (ISO 8601 duration) */
  timeout?: string;
  /** Whether the executor can modify the case payload */
  can_modify_payload: boolean;
  /** Fields that must not be changed */
  read_only_fields?: string[];
  /** Whether the executor can create sub-cases */
  can_create_subcases: boolean;
  /** Approval required before proceeding */
  requires_approval: boolean;
}

export interface ExpectedOutput {
  /** Description of what the step should produce */
  description: string;
  /** Expected output fields (key → type hint) */
  output_fields?: Record<string, string>;
  /** Whether output is mandatory for case to proceed */
  mandatory: boolean;
}

// ── Packet assembly ──────────────────────────────────────────────────────────

/**
 * Assemble a context packet from workflow definition, case, work item, and role data.
 */
export function assemblePacket(params: {
  definition: WorkflowDefinition;
  case: Case;
  workItem: WorkItem;
  element: WorkflowElement;
  instruction?: string;
  documents?: DocumentRef[];
  roleContract?: RoleContract;
}): ContextPacket {
  const { definition, case: kase, workItem, element, instruction, documents, roleContract } = params;

  // Build position context
  const byId = new Map(definition.elements.map(e => [e.id, e]));
  const predecessors: StepPosition["predecessors"] = [];
  const successors: StepPosition["successors"] = [];

  for (const [from, to] of definition.flow) {
    if (to === element.id) {
      const el = byId.get(from);
      if (el) predecessors.push({ id: from, label: el.label, type: el.type });
    }
    if (from === element.id) {
      const el = byId.get(to);
      if (el) successors.push({ id: to, label: el.label, type: el.type });
    }
  }

  // Build system bindings
  const systems: SystemBindingContext[] = (element.systems ?? []).map(s => ({
    connector: s.connector,
    operation: s.operation,
  }));

  // Build artifacts from history
  const artifacts: ArtifactRef[] = (kase.history ?? [])
    .filter(h => h.output && Object.keys(h.output).length > 0)
    .map(h => {
      const el = byId.get(h.element_id);
      return {
        name: h.label ?? h.element_id,
        source_element_id: h.element_id,
        source_label: h.label,
        data: h.output,
        produced_at: h.timestamp,
      };
    });

  return {
    version: 1,
    packet_id: workItem.work_item_id,
    assembled_at: new Date().toISOString(),

    process: {
      process_id: kase.process_id,
      process_version: kase.process_version,
      process_name: definition.name,
      case_id: kase.case_id,
      case_subject: kase.subject,
    },

    step: {
      element_id: element.id,
      label: element.label,
      intent: element.intent,
      element_type: "function",
      position: { predecessors, successors },
      instruction,
    },

    assignment: {
      role: element.role ?? workItem.assignee,
      executor_contract: roleContract,
      assignee: workItem.assignee,
      deadline: workItem.deadline,
    },

    case_data: {
      payload: kase.payload,
      recent_history: (kase.history ?? []).slice(-5),
      status: kase.status,
      created_at: kase.created_at,
    },

    documents: documents ?? [],

    systems,

    artifacts,

    constraints: {
      can_modify_payload: true,
      can_create_subcases: !!element.sub_process_id,
      requires_approval: false,
    },

    expected_output: {
      description: element.intent ?? element.label,
      mandatory: true,
    },
  };
}

// ── Packet rendering ─────────────────────────────────────────────────────────

/**
 * Render a context packet as a human-readable text message.
 * Used when dispatching to agents and persons via Konoha bus / Telegram.
 */
export function renderPacketForAgent(packet: ContextPacket): string {
  const lines: string[] = [
    `[Задача от runtime]`,
    `Процесс: ${packet.process.process_name} (${packet.process.process_id})`,
    `Прогон: ${packet.process.case_id} — ${packet.process.case_subject}`,
    ``,
    `→ СЕЙЧАС: ${packet.step.label}`,
  ];

  if (packet.step.intent) {
    lines.push(`  Цель: ${packet.step.intent}`);
  }

  if (packet.step.position.predecessors.length) {
    lines.push(`До: ${packet.step.position.predecessors.map(p => `${p.label} [${p.type}]`).join(", ")}`);
  }
  if (packet.step.position.successors.length) {
    lines.push(`После: ${packet.step.position.successors.map(s => `${s.label} [${s.type}]`).join(", ")}`);
  }

  lines.push(``);
  lines.push(`Роль: ${packet.assignment.role}`);
  lines.push(`work_item_id: ${packet.packet_id}`);

  if (packet.step.instruction) {
    lines.push(``);
    lines.push(`Инструкция:`);
    lines.push(packet.step.instruction);
  }

  if (Object.keys(packet.case_data.payload).length > 0) {
    lines.push(``);
    lines.push(`Данные прогона:`);
    lines.push(JSON.stringify(packet.case_data.payload, null, 2));
  }

  if (packet.artifacts.length > 0) {
    lines.push(``);
    lines.push(`Артефакты предыдущих шагов:`);
    for (const a of packet.artifacts) {
      lines.push(`  — ${a.name}: ${JSON.stringify(a.data).slice(0, 200)}`);
    }
  }

  if (packet.systems.length > 0) {
    lines.push(``);
    lines.push(`Системы: ${packet.systems.map(s => s.connector + (s.operation ? ` (${s.operation})` : "")).join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * Render a shorter context packet for human/person dispatch via Telegram.
 */
export function renderPacketForPerson(packet: ContextPacket): string {
  const lines = [
    `Новая задача: ${packet.step.label}`,
    `Процесс: ${packet.process.process_name}`,
    `Кейс: ${packet.process.case_subject}`,
    `ID: ${packet.packet_id}`,
  ];

  if (packet.step.intent) {
    lines.push(`Цель: ${packet.step.intent}`);
  }

  if (packet.step.instruction) {
    lines.push(``);
    lines.push(packet.step.instruction);
  }

  return lines.join("\n");
}
