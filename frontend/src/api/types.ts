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
  parent_id?: string;
  parent_function_id?: string;
  /** Set by trigger-resolver when deploy is blocked and manual review is required */
  needs_review?: boolean;
}

export interface WorkflowElement {
  id: string;
  type: 'event' | 'function' | 'gateway' | 'role' | 'executor' | 'document' | 'information_system' | 'system';
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
  // Trigger config (start event nodes only)
  trigger?: {
    // Legacy type field (kept for backward compat)
    type?: 'manual' | 'telegram' | 'schedule' | 'event' | 'webhook';
    // Extended trigger kind from event-manager
    kind?: 'timer' | 'message' | 'condition' | 'delay_after' | 'manual' | 'system' | 'ambiguous';
    /** 0–1 confidence score from trigger-resolver */
    confidence?: number;
    /** Candidates when kind=ambiguous */
    candidates?: Array<{ kind: string; description: string; confidence: number }>;
    /** Set when user has manually chosen/overridden the trigger */
    manual_override?: boolean;
    /** mode=manual means condition trigger has no registered adapter */
    mode?: 'auto' | 'manual';
    // Legacy fields
    chat_id?: string;
    keyword?: string;
    cron?: string;
    event_type?: string;
    webhook_path?: string;
  };
  // Registry reference: role_id or doc_id from the registry picker
  ref_id?: string;
  // Sub-process: immutable boundary events locked to parent interface
  locked?: boolean;
  // Intent-based execution: outcome/goal for AI agent (vs instruction-based label)
  intent?: string;
}

export interface WorkflowTrigger {
  event: string;
  start_node?: string;
}

export type CaseStatus = 'running' | 'done' | 'error';
export type RunStatus = CaseStatus;

/** Alias for Case — use Run in new code */
export interface Run {
  case_id: string;      // kept as case_id for API compat — "прогон" in UI
  process_id: string;
  process_version: string;
  subject: string;
  status: RunStatus;
  position?: string;    // current step element_id
  current_step_label?: string;  // human-readable current step
  sla_ok?: boolean;     // true = on time, false = overdue/at risk
  elapsed_ms?: number;  // time in current step (ms)
  payload: Record<string, unknown>;
  history: HistoryEntry[];
  created_at: string;
}

/** @deprecated use Run */
export type Case = Run;

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

export type EventWaitStatus = 'active' | 'fired' | 'cancelled' | 'overdue' | 'escalated';

export interface EventWait {
  wait_id: string;
  case_id: string;
  process_id: string;
  element_id: string;
  element_label?: string;
  trigger_kind: 'timer' | 'message' | 'condition' | 'delay_after' | 'manual';
  status: EventWaitStatus;
  created_at: string;
  resolved_at?: string;
  deadline?: string;
  assignee?: string;
  subscription_id?: string;
  reminder_count?: number;
  last_reminder_at?: string;
  escalation_target?: string;
  event_data?: Record<string, unknown>;
}

export interface WorkItemFilters {
  assignee?: string;
  process_id?: string;
  status?: WorkItemStatus | '';
  deadline_before?: string;
}

export type WorkflowActionStatus = 'executed' | 'needs_confirm' | 'failed' | 'skipped';
export type WorkflowActionType = 'workflow.create' | 'workflow.update' | 'workflow.open' | 'workflow.save' | 'workflow.confirm' | 'case.start';
export type WorkflowReceiptStatus = 'succeeded' | 'pending_confirmation' | 'failed' | 'partial';
export type WorkflowObservableStatus = WorkflowReceiptStatus | 'no_effect';
export type WorkflowResourceKind = 'workflow' | 'element' | 'flow' | 'confirmation' | 'case' | 'work_item';
export type WorkflowResourceChange = 'created' | 'updated' | 'opened' | 'started' | 'pending' | 'failed';

export interface WorkflowAssistantAction {
  action: WorkflowActionType | string;
  params: Record<string, unknown>;
  status: WorkflowActionStatus;
  description: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface WorkflowPendingConfirmation {
  id: string;
  action: WorkflowActionType | string;
  title: string;
  summary: string;
  status: 'required';
  permission: {
    actor_scope: 'assistant_on_behalf_of_user';
    autonomy: 'confirm';
    confirmation_required: true;
  };
  params: Record<string, unknown>;
}

export interface WorkflowActionReceipt {
  id: string;
  action: WorkflowActionType | string;
  status: WorkflowReceiptStatus;
  summary: string;
  details?: string;
  changed_resources: Array<{
    kind: WorkflowResourceKind;
    id: string;
    label?: string;
    change: WorkflowResourceChange;
  }>;
  audit: {
    session_id: string;
    action_type: WorkflowActionType | string;
  };
}

export interface WorkflowObservableResult {
  status: WorkflowObservableStatus;
  summary: string;
  receipts: WorkflowActionReceipt[];
  counts: {
    succeeded: number;
    pending_confirmation: number;
    failed: number;
    partial: number;
  };
}

export interface AssistantWorkflowResponse {
  reply: string;
  chat_id: string;
  schema_patch: unknown | null;
  created_workflow: { id: string; name: string } | null;
  actions?: AssistantUiAction[];
  actions_taken: WorkflowAssistantAction[];
  action_receipts: WorkflowActionReceipt[];
  observable_result: WorkflowObservableResult;
  pending_confirmations: WorkflowPendingConfirmation[];
}

export interface DashboardProfile {
  username: string;
  display_name: string;
  position?: string;
  email?: string;
  telegram_username?: string;
  telegram_id?: number;
  person_id?: string;
  avatar_url?: string;
  capabilities?: string[];
  updated_at?: string;
}

export type AssignmentStrategy = 'round-robin' | 'load-balancing' | 'broadcast' | 'manual';

export interface RoleDef {
  role_id: string;
  name: string;
  description?: string;
  assignees: string[];
  strategy: AssignmentStrategy;
  required_capabilities?: string[];
  created_at: string;
  updated_at: string;
}

export interface McpServerDef {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Skill {
  id: string;
  name: string;
  name_en?: string;
  description?: string;
  prompt_snippet?: string;
  tools?: string[];
  mcp_servers?: McpServerDef[];
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
  display_alias?: string;
  status: string;
  roles?: string[];
  capabilities?: string[];
  model?: string;
  runtime?: 'claude' | 'codex' | 'cursor' | 'glm';
  fallback_runtime?: 'claude' | 'codex' | 'cursor' | 'glm';
  reasoning_effort?: string;
  system_prompt?: string;
  tags?: string[];
  lifecycle?: AgentLifecycle;
  lastHeartbeat?: number;
  village_id?: string;
  avatar_url?: string;
  gender?: 'male' | 'female' | 'neutral';
  protected?: boolean;
  seed_classification?: 'core' | 'optional_worker' | 'connector_owned' | 'deprecated_compat' | 'out_of_scope';
  lifecycle_mode?: 'core' | 'optional_on_demand' | 'connector_owned' | 'deprecated';
  display?: {
    name: string;
    alias?: string;
    locale: string;
    source: {
      name: 'org_override' | 'locale_catalog' | 'neutral_default';
      alias?: 'org_override' | 'locale_catalog' | 'neutral_default';
    };
  };
}

export interface AdapterHealth {
  adapter: string;
  healthy: boolean;
}

export type TelegramStreamStatus = 'ok' | 'warn' | 'fail';

export interface TelegramConsumerGroupHealth {
  group: string;
  consumers: number;
  pending: number;
  lag: number;
  status: TelegramStreamStatus;
  detail: string;
}

export interface TelegramStreamHealth {
  stream: string;
  length: number;
  groups: TelegramConsumerGroupHealth[];
  status: TelegramStreamStatus;
}

export interface TelegramDeadLetterHealth {
  stream: string;
  length: number;
  status: TelegramStreamStatus;
}

export interface TelegramStreamHealthSummary {
  thresholds: {
    warn_lag: number;
    warn_pending: number;
    fail_pending: number;
  };
  streams: TelegramStreamHealth[];
  dead_letters: TelegramDeadLetterHealth[];
  status: TelegramStreamStatus;
  checked_at: string;
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
  work_item_id?: string;
  created_at: string;
  updated_at: string;
}

export interface KonohaMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  type: string;
  timestamp: string;
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
  capabilities?: string[];
  avatar_url?: string;
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

export interface MiningElementStat {
  label: string;
  type: string;
  visit_count: number;
  avg_duration_ms: number | null;
  max_duration_ms: number | null;
  p50_duration_ms: number | null;
}

export interface ProcessMiningData {
  process_id: string;
  case_count: number;
  elements: Record<string, MiningElementStat>;
  edges: Record<string, { count: number; is_designed: boolean }>;
  bottleneck_element_id: string | null;
  deviation_elements: string[];
  skipped_elements: string[];
}

export interface KibaAction {
  label: string;
  type: 'start_agent' | 'stop_agent' | 'restart_agent' | 'delete_agent' | 'create_role' | 'delete_role';
  args: Record<string, unknown>;
}

/** Action returned by Tsunade/process-chat to trigger visual UI guidance (#315) */
export interface HighlightAction {
  type: 'highlight';
  selector: string;
  target?: string;
  message?: string;
  style?: 'spotlight' | 'pointer' | 'outline';
}

export interface NavigateAction {
  type: 'navigate';
  target?: string;
  path?: string;
  workflow_id?: string;
  message?: string;
}

export type AssistantUiAction = HighlightAction | NavigateAction;
