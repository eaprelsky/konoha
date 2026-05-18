/**
 * runtime/cases/types.ts — Shared type definitions for the cases module.
 * Extracted from cases.ts (#507).
 */

export type CaseStatus = "running" | "done" | "error" | "cancelled";
export type WorkItemStatus = "pending" | "running" | "done" | "cancelled" | "error";

export interface HistoryEntry {
  element_id: string;
  element_type: string;
  label: string;
  timestamp: string;
  work_item_id?: string;
  output?: Record<string, unknown>;
}

export interface ActiveBranch {
  element_id: string;
  work_item_id: string;
  done: boolean;
}

export interface Case {
  case_id: string;
  process_id: string;
  process_version: string;
  subject: string;
  status: CaseStatus;
  position: string;
  active_branches?: ActiveBranch[];
  payload: Record<string, unknown>;
  history: HistoryEntry[];
  created_at: string;
  parent_work_item_id?: string;
  parent_case_id?: string;
  needs_attention?: boolean;
}

export interface WorkItem {
  work_item_id: string;
  case_id: string | null;
  process_id: string | null;
  element_id: string | null;
  label: string;
  assignee: string;
  status: WorkItemStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  deadline?: string;
  created_at: string;
  updated_at: string;
  child_case_id?: string;
}
