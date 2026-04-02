// ── Konoha API types ──────────────────────────────────────────────────────────

export interface Workflow {
  id: string;
  name: string;
  version?: string;
  description?: string;
  category?: string;
  elements: WorkflowElement[];
  flow: [string, string, string?][];
  triggers?: WorkflowTrigger[];
}

export interface WorkflowElement {
  id: string;
  type: 'event' | 'function' | 'gateway' | 'role' | 'document' | 'information_system' | 'system';
  label: string;
  role?: string;
  system?: string;
  operator?: string;
}

export interface WorkflowTrigger {
  event: string;
  start_node?: string;
}

export type CaseStatus = 'running' | 'done' | 'error';

export interface Case {
  case_id: string;
  process_id: string;
  process_version: string;
  subject: string;
  status: CaseStatus;
  position?: string;
  payload: Record<string, unknown>;
  history: HistoryEntry[];
  created_at: string;
}

export interface HistoryEntry {
  element_id: string;
  element_type: string;
  label: string;
  timestamp: string;
  work_item_id?: string;
  output?: Record<string, unknown>;
}

export type WorkItemStatus = 'pending' | 'running' | 'done' | 'cancelled' | 'error';

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
}

export interface WorkItemFilters {
  assignee?: string;
  process_id?: string;
  status?: WorkItemStatus | '';
  deadline_before?: string;
}
