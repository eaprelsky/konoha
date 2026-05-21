// Storage layer interfaces — Phase 1 (PostgreSQL shadow writes)
// All business data goes through these interfaces.
// Current default: Redis (unchanged). PG shadow-writes in parallel.

export interface WorkflowRecord {
  id: string;
  name: string;
  version: string;
  elements: unknown[];
  flow: unknown[];
  triggers?: unknown[];
  status?: string;
  lifecycle_state?: string;
  lifecycle?: Record<string, unknown>;
  validation_status?: string;
  edit_version?: number;
  deploy_version?: number;
  deployed_at?: string;
  deployed_by?: string;
  retired_at?: string;
  retired_by?: string;
  last_validation?: Record<string, unknown>;
  last_deploy?: Record<string, unknown>;
  parent_id?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface CaseRecord {
  case_id: string;
  process_id: string;
  version?: string;
  subject: string;
  status: string;
  position?: string;
  payload: Record<string, unknown>;
  history: unknown[];
  created_at?: string;
  updated_at?: string;
}

export interface WorkItemRecord {
  id: string;
  case_id?: string;
  process_id?: string;
  element_id?: string;
  label: string;
  assignee?: string;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  deadline?: string;
  created_at?: string;
  updated_at?: string;
}

export interface RoleRecord {
  id: string;
  name: string;
  description?: string;
  assignees: string[];
  strategy: string;
  created_at?: string;
  updated_at?: string;
}

export interface DocRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  parameters?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface ReminderRecord {
  id: string;
  type: string;
  recipient: string;
  message: string;
  scheduled_at: string;
  channel: string;
  status: string;
  case_id?: string;
  process_id?: string;
  element_id?: string;
  work_item_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface SkillRecord {
  id: string;
  name: string;
  name_en?: string;
  description?: string;
  prompt_snippet?: string;
  tools?: string[];
  mcp_servers?: unknown[];
  created_at?: string;
  updated_at?: string;
}
