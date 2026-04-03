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
  x?: number;
  y?: number;
  // Document node inline content
  content_type?: 'instruction' | 'file';
  content?: string;
  file_ref?: string;
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

export type AssignmentStrategy = 'round-robin' | 'load-balancing' | 'broadcast' | 'manual';

export interface RoleDef {
  role_id: string;
  name: string;
  description?: string;
  assignees: string[];
  strategy: AssignmentStrategy;
  created_at: string;
  updated_at: string;
}

export type DocType = 'prompt' | 'instruction' | 'form' | 'template' | 'attachment';

export interface DocTemplate {
  doc_id: string;
  name: string;
  type: DocType;
  content: string;
  parameters: string[];
  created_at: string;
  updated_at: string;
}

export interface RuntimeEvent {
  id?: string;
  type: string;
  case_id?: string;
  process_id?: string;
  work_item_id?: string;
  element_id?: string;
  label?: string;
  timestamp: string;
}

export interface AgentLifecycle {
  status: string;
  pid?: number;
  uptime_seconds?: number;
}

export interface Agent {
  id: string;
  name: string;
  status: string;
  roles?: string[];
  capabilities?: string[];
  model?: string;
  system_prompt?: string;
  tags?: string[];
  lifecycle?: AgentLifecycle;
  lastHeartbeat?: number;
  village_id?: string;
}

export interface AdapterHealth {
  adapter: string;
  healthy: boolean;
}

export type ReminderStatus = 'pending' | 'sent' | 'acknowledged' | 'overdue';
export type ReminderChannel = 'gui' | 'telegram' | 'email';
export type ReminderType = 'standalone' | 'process-bound';

export interface Reminder {
  reminder_id: string;
  type: ReminderType;
  recipient: string;
  message: string;
  scheduled_at: string;
  channel: ReminderChannel;
  status: ReminderStatus;
  case_id?: string;
  process_id?: string;
  element_id?: string;
  created_at: string;
  updated_at: string;
}

export interface KonohaMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  type: string;
  ts: number;
  channel?: string;
}

export interface AgentStatus {
  status: string;
  pid?: number;
  uptime_seconds?: number;
  started_at?: string;
}

export interface Person {
  id: string;
  name: string;
  tg_id: number;
  position: string;
  tg_username?: string;
  email?: string;
  source?: 'file' | 'custom';
  bitrix24_id?: string;
  tracker_login?: string;
  yonote_id?: string;
  channel?: 'telegram' | 'email';
}

export interface WorkspaceFile {
  name: string;
  size: number;
  modified_at: string;
}

export interface KbNode {
  type: 'file' | 'dir';
  name: string;
  path: string;
  size?: number;
  ext?: string;
  children?: KbNode[];
}
