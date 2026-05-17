import { cancelSubscriptionsByInstance } from "../event-manager";
import { silentCatch, createLogger } from "../logger";
import { redis, listAgents } from "../redis";
import { cancelEventWaitsForCase } from "../runtime/event-waits";
import {
  CASE_KEY_PREFIX,
  CASES_IDX_ALL,
  CASES_IDX_PROCESS,
  CASES_IDX_STATUS,
  WORKITEM_KEY_PREFIX,
  WORKITEMS_IDX_ALL,
  WORKITEMS_IDX_ASSIGNEE,
  WORKITEMS_IDX_CASE,
  WORKITEMS_IDX_PROCESS,
  WORKITEMS_IDX_STATUS,
  type Case,
  type WorkItem,
} from "../runtime/cases";
import { pgDeleteCase, pgDeleteWorkItem } from "../storage/pg";

const log = createLogger("retention:runtime-cleanup");

const GENERATED_RUNTIME_RE = /^(act-wf|assistant-start|autonomy-eval|debug|eepc|operator-eval|or-gw|test|xor-gw)(?:-|\d|$)/;
const ACTIVE_WORKITEM_STATUSES = new Set(["pending", "running"]);
const TERMINAL_WORKITEM_STATUSES = new Set(["done", "cancelled", "error"]);
const TERMINAL_CASE_STATUSES = new Set(["done", "error"]);

export interface RuntimeRetentionPolicy {
  stuckCaseTtlHours: number;
  completedWorkflowTtlHours: number;
  maxDelete: number;
}

export type RuntimeRetentionReason = "stuck_case" | "completed_workflow_run";

export interface RuntimeRetentionCandidate {
  entity: "case";
  id: string;
  process_id: string;
  status: Case["status"];
  reason: RuntimeRetentionReason;
  safe_classification: "generated_or_test_runtime" | "explicit_auto_delete";
  updated_at: string;
  age_hours: number;
  work_items: number;
  active_work_items: number;
}

export interface RuntimeRetentionCleanupResult {
  mode: "dry_run" | "apply";
  generated_at: string;
  policy: RuntimeRetentionPolicy;
  scanned_cases: number;
  candidate_count: number;
  omitted_due_to_limit: number;
  deleted_count: number;
  candidates: RuntimeRetentionCandidate[];
  deleted: RuntimeRetentionCandidate[];
}

interface CandidateContext {
  candidate: RuntimeRetentionCandidate;
  caseRecord: Case;
  workItems: WorkItem[];
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function runtimeRetentionPolicyFromEnv(): RuntimeRetentionPolicy {
  return {
    stuckCaseTtlHours: numberFromEnv("KONOHA_STUCK_CASE_TTL_HOURS", 24),
    completedWorkflowTtlHours: numberFromEnv("KONOHA_COMPLETED_WORKFLOW_TTL_HOURS", 24),
    maxDelete: Math.floor(numberFromEnv("KONOHA_RUNTIME_RETENTION_MAX_DELETE", 100)),
  };
}

function asDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function latestCaseActivity(kase: Case, workItems: WorkItem[]): Date {
  const dates: Date[] = [];
  const created = asDate(kase.created_at);
  if (created) dates.push(created);
  for (const entry of kase.history ?? []) {
    const timestamp = asDate(entry.timestamp);
    if (timestamp) dates.push(timestamp);
  }
  for (const wi of workItems) {
    const updated = asDate(wi.updated_at) ?? asDate(wi.created_at);
    if (updated) dates.push(updated);
  }
  return dates.reduce((latest, current) => current > latest ? current : latest, created ?? new Date(0));
}

function ageHours(updatedAt: Date, now: Date): number {
  return Math.max(0, (now.getTime() - updatedAt.getTime()) / (60 * 60 * 1000));
}

function retentionOptIn(payload: Record<string, unknown>): boolean {
  const retention = payload.retention;
  if (retention && typeof retention === "object" && !Array.isArray(retention)) {
    if ((retention as Record<string, unknown>).auto_delete === true) return true;
  }
  const internal = payload.__retention;
  if (internal && typeof internal === "object" && !Array.isArray(internal)) {
    if ((internal as Record<string, unknown>).auto_delete === true) return true;
  }
  return false;
}

function safeClassification(kase: Case): RuntimeRetentionCandidate["safe_classification"] | null {
  if (GENERATED_RUNTIME_RE.test(kase.process_id) || GENERATED_RUNTIME_RE.test(kase.case_id)) {
    return "generated_or_test_runtime";
  }
  if (retentionOptIn(kase.payload)) return "explicit_auto_delete";
  return null;
}

function hasOnlineAssignee(workItems: WorkItem[], onlineAgentIds: Set<string>): boolean {
  return workItems.some(wi =>
    ACTIVE_WORKITEM_STATUSES.has(wi.status)
    && wi.assignee !== "unassigned"
    && onlineAgentIds.has(wi.assignee)
  );
}

function allWorkItemsTerminated(workItems: WorkItem[]): boolean {
  return workItems.every(wi => TERMINAL_WORKITEM_STATUSES.has(wi.status));
}

async function loadCaseFromRedis(caseId: string): Promise<Case | null> {
  const raw = await redis.get(CASE_KEY_PREFIX + caseId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Case;
  } catch {
    return null;
  }
}

async function loadWorkItemsForCase(caseId: string): Promise<WorkItem[]> {
  const ids = await redis.smembers(WORKITEMS_IDX_CASE + caseId);
  if (ids.length === 0) return [];
  const raws = await redis.mget(...ids.map(id => WORKITEM_KEY_PREFIX + id));
  const items: WorkItem[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      items.push(JSON.parse(raw) as WorkItem);
    } catch {
      // skip corrupt work item rows; cleanup must not make decisions from them
    }
  }
  return items;
}

async function collectCandidates(
  policy: RuntimeRetentionPolicy,
  now: Date,
  onlineAgentIds: Set<string>,
): Promise<{ scanned: number; candidates: CandidateContext[] }> {
  const caseIds = await redis.zrange(CASES_IDX_ALL, 0, -1);
  const candidates: CandidateContext[] = [];

  for (const caseId of caseIds) {
    const kase = await loadCaseFromRedis(caseId);
    if (!kase) continue;

    const classification = safeClassification(kase);
    if (!classification) continue;

    const workItems = await loadWorkItemsForCase(caseId);
    const activeWorkItems = workItems.filter(wi => ACTIVE_WORKITEM_STATUSES.has(wi.status));
    const updatedAt = latestCaseActivity(kase, workItems);
    const age = ageHours(updatedAt, now);

    let reason: RuntimeRetentionReason | null = null;
    if (TERMINAL_CASE_STATUSES.has(kase.status) && allWorkItemsTerminated(workItems) && age >= policy.completedWorkflowTtlHours) {
      reason = "completed_workflow_run";
    } else if (
      kase.status === "running"
      && age >= policy.stuckCaseTtlHours
      && !hasOnlineAssignee(workItems, onlineAgentIds)
    ) {
      reason = "stuck_case";
    }

    if (!reason) continue;
    candidates.push({
      caseRecord: kase,
      workItems,
      candidate: {
        entity: "case",
        id: kase.case_id,
        process_id: kase.process_id,
        status: kase.status,
        reason,
        safe_classification: classification,
        updated_at: updatedAt.toISOString(),
        age_hours: Number(age.toFixed(2)),
        work_items: workItems.length,
        active_work_items: activeWorkItems.length,
      },
    });
  }

  return { scanned: caseIds.length, candidates };
}

async function deleteCaseRuntimeArtifacts(kase: Case, workItems: WorkItem[]): Promise<void> {
  const pipe = redis.pipeline();
  for (const wi of workItems) {
    pipe.del(WORKITEM_KEY_PREFIX + wi.work_item_id);
    pipe.zrem(WORKITEMS_IDX_ALL, wi.work_item_id);
    pipe.srem(WORKITEMS_IDX_STATUS + wi.status, wi.work_item_id);
    pipe.srem(WORKITEMS_IDX_ASSIGNEE + wi.assignee, wi.work_item_id);
    if (wi.process_id) pipe.srem(WORKITEMS_IDX_PROCESS + wi.process_id, wi.work_item_id);
    if (wi.case_id) pipe.srem(WORKITEMS_IDX_CASE + wi.case_id, wi.work_item_id);
  }
  pipe.del(WORKITEMS_IDX_CASE + kase.case_id);
  pipe.del(CASE_KEY_PREFIX + kase.case_id);
  pipe.zrem(CASES_IDX_ALL, kase.case_id);
  for (const status of ["running", "done", "error"]) {
    pipe.srem(CASES_IDX_STATUS + status, kase.case_id);
  }
  pipe.srem(CASES_IDX_PROCESS + kase.process_id, kase.case_id);
  await pipe.exec();

  cancelSubscriptionsByInstance(kase.case_id).catch(silentCatch("runtime retention subscription cleanup"));
  cancelEventWaitsForCase(kase.case_id).catch(silentCatch("runtime retention event wait cleanup"));
  await Promise.all(workItems.map(wi => pgDeleteWorkItem(wi.work_item_id).catch(() => {})));
  await pgDeleteCase(kase.case_id).catch(() => {});
}

export async function cleanupExpiredRuntimeArtifacts(options: {
  dryRun?: boolean;
  policy?: Partial<RuntimeRetentionPolicy>;
  now?: Date;
  onlineAgentIds?: Set<string>;
} = {}): Promise<RuntimeRetentionCleanupResult> {
  const now = options.now ?? new Date();
  const envPolicy = runtimeRetentionPolicyFromEnv();
  const policy: RuntimeRetentionPolicy = {
    stuckCaseTtlHours: options.policy?.stuckCaseTtlHours ?? envPolicy.stuckCaseTtlHours,
    completedWorkflowTtlHours: options.policy?.completedWorkflowTtlHours ?? envPolicy.completedWorkflowTtlHours,
    maxDelete: Math.max(0, Math.floor(options.policy?.maxDelete ?? envPolicy.maxDelete)),
  };
  const onlineAgentIds = options.onlineAgentIds ?? new Set((await listAgents(true)).map(agent => agent.id));
  const { scanned, candidates: contexts } = await collectCandidates(policy, now, onlineAgentIds);
  const selected = contexts.slice(0, policy.maxDelete);
  const dryRun = options.dryRun !== false;
  const deleted: RuntimeRetentionCandidate[] = [];

  if (!dryRun) {
    for (const context of selected) {
      await deleteCaseRuntimeArtifacts(context.caseRecord, context.workItems);
      deleted.push(context.candidate);
    }
    if (deleted.length > 0) {
      log.warn("runtime retention deleted expired artifacts", { deleted: deleted.length });
    }
  }

  return {
    mode: dryRun ? "dry_run" : "apply",
    generated_at: now.toISOString(),
    policy,
    scanned_cases: scanned,
    candidate_count: contexts.length,
    omitted_due_to_limit: Math.max(0, contexts.length - selected.length),
    deleted_count: deleted.length,
    candidates: selected.map(context => context.candidate),
    deleted,
  };
}
