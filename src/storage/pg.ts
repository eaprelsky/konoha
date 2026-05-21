// PostgreSQL storage layer — Phase 1 shadow writes
// Strategy: write to BOTH Redis (primary) and PG (shadow).
// All reads still come from Redis. PG errors are logged, never surfaced.
//
// Connection: DATABASE_URL env var or local DB without embedded credentials

import postgres from "postgres";
import type {
  WorkflowRecord, CaseRecord, WorkItemRecord,
  RoleRecord, DocRecord, ReminderRecord, SkillRecord,
} from "./types";
import { getDatabaseUrl } from "./database-url";
import { createLogger } from "../logger";

const log = createLogger("storage:pg");

// postgres's sql.json() requires JSONValue, but our domain types are structurally compatible
// at runtime. This helper centralises the cast instead of spreading `as any` everywhere.
type JSONValue = Parameters<ReturnType<typeof postgres>["json"]>[0];
const asJson = (v: unknown): JSONValue => v as JSONValue;

const DATABASE_URL = getDatabaseUrl();

let _sql: ReturnType<typeof postgres> | null = null;
let workflowLifecycleColumnsReady = false;

function asDateOrNull(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function getSql(): ReturnType<typeof postgres> {
  if (!_sql) {
    _sql = postgres(DATABASE_URL, {
      max: 5,
      idle_timeout: 30,
      connect_timeout: 5,
      onnotice: () => {},
    });
  }
  return _sql;
}

// Safe wrapper: logs PG errors, never throws
async function pgWrite(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e: any) {
    log.error("shadow write error", { error: e.message });
  }
}

// ── Workflows ─────────────────────────────────────────────────────────────────

async function ensureWorkflowLifecycleColumns(sql: ReturnType<typeof postgres>): Promise<void> {
  if (workflowLifecycleColumnsReady) return;
  await sql`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'executable'`;
  await sql`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS lifecycle JSONB NOT NULL DEFAULT '{}'`;
  await sql`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'unknown'`;
  await sql`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS deploy_version BIGINT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS deployed_at TIMESTAMPTZ`;
  await sql`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS deployed_by TEXT`;
  await sql`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ`;
  await sql`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS retired_by TEXT`;
  await sql`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS last_validation JSONB`;
  await sql`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS last_deploy JSONB`;
  await sql`CREATE INDEX IF NOT EXISTS idx_workflows_lifecycle_state ON workflows(lifecycle_state)`;
  await sql`
    WITH workflow_lifecycle_backfill AS (
      SELECT id, CASE
        WHEN status = 'draft' THEN 'draft'
        WHEN status = 'needs_review' THEN 'validated'
        WHEN status IN ('archived', 'deleted', 'retired') THEN 'retired'
        WHEN status IN ('validated', 'deployed', 'executable') THEN status
        WHEN lifecycle_state IN ('draft', 'validated', 'deployed', 'executable', 'retired') THEN lifecycle_state
        ELSE 'executable'
      END AS canonical_state
      FROM workflows
    )
    UPDATE workflows
    SET lifecycle_state = workflow_lifecycle_backfill.canonical_state,
        status = workflow_lifecycle_backfill.canonical_state,
        lifecycle = CASE
          WHEN lifecycle = '{}'::jsonb THEN jsonb_build_object(
            'schema_version', 1,
            'state', workflow_lifecycle_backfill.canonical_state,
            'status', workflow_lifecycle_backfill.canonical_state,
            'validation_status', validation_status,
            'deploy_version', deploy_version,
            'migrated_from_status', status,
            'backfilled_at', NOW()
          )
          ELSE lifecycle
        END
    FROM workflow_lifecycle_backfill
    WHERE workflows.id = workflow_lifecycle_backfill.id
  `;
  workflowLifecycleColumnsReady = true;
}

export async function pgUpsertWorkflow(wf: WorkflowRecord): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await ensureWorkflowLifecycleColumns(sql);
    const lifecycleState = String((wf as any).lifecycle_state || (wf as any).status || 'executable');
    const deployVersion = Number((wf as any).deploy_version ?? (wf as any).lifecycle?.deploy_version ?? 0);
    await sql`
      INSERT INTO workflows (
        id, name, version, elements, flow, triggers, status,
        lifecycle_state, lifecycle, validation_status, deploy_version,
        deployed_at, deployed_by, retired_at, retired_by,
        last_validation, last_deploy, parent_id, updated_at
      )
      VALUES (
        ${wf.id}, ${wf.name || ''}, ${wf.version || '1.0.0'},
        ${sql.json(asJson(wf.elements ?? []))},
        ${sql.json(asJson(wf.flow ?? []))},
        ${sql.json(asJson((wf as any).triggers ?? []))},
        ${(wf as any).status || lifecycleState},
        ${lifecycleState},
        ${sql.json(asJson((wf as any).lifecycle ?? {}))},
        ${(wf as any).validation_status || (wf as any).lifecycle?.validation_status || 'unknown'},
        ${Number.isFinite(deployVersion) ? Math.trunc(deployVersion) : 0},
        ${asDateOrNull((wf as any).deployed_at || (wf as any).lifecycle?.deployed_at)},
        ${(wf as any).deployed_by || (wf as any).lifecycle?.deployed_by || null},
        ${asDateOrNull((wf as any).retired_at || (wf as any).lifecycle?.retired_at)},
        ${(wf as any).retired_by || (wf as any).lifecycle?.retired_by || null},
        ${(wf as any).last_validation ? sql.json(asJson((wf as any).last_validation)) : null},
        ${(wf as any).last_deploy ? sql.json(asJson((wf as any).last_deploy)) : null},
        ${(wf as any).parent_id || null},
        ${wf.updated_at ? new Date(wf.updated_at) : new Date()}
      )
      ON CONFLICT (id) DO UPDATE SET
        name         = EXCLUDED.name,
        version      = EXCLUDED.version,
        elements     = EXCLUDED.elements,
        flow         = EXCLUDED.flow,
        triggers     = EXCLUDED.triggers,
        status       = EXCLUDED.status,
        lifecycle_state = EXCLUDED.lifecycle_state,
        lifecycle    = EXCLUDED.lifecycle,
        validation_status = EXCLUDED.validation_status,
        deploy_version = EXCLUDED.deploy_version,
        deployed_at  = EXCLUDED.deployed_at,
        deployed_by  = EXCLUDED.deployed_by,
        retired_at   = EXCLUDED.retired_at,
        retired_by   = EXCLUDED.retired_by,
        last_validation = EXCLUDED.last_validation,
        last_deploy  = EXCLUDED.last_deploy,
        parent_id    = EXCLUDED.parent_id,
        updated_at   = EXCLUDED.updated_at
    `;
  });
}

export async function pgDeleteWorkflow(id: string): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await sql`DELETE FROM workflows WHERE id = ${id}`;
  });
}

export async function pgSaveWorkflowSnapshot(
  workflowId: string, snapshotNum: number, data: WorkflowRecord
): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    const savedAt = (data as any).saved_at ? new Date((data as any).saved_at) : new Date();
    await sql`
      INSERT INTO workflow_snapshots (workflow_id, snapshot_num, data, saved_at)
      VALUES (${workflowId}, ${snapshotNum}, ${sql.json(asJson(data))}, ${savedAt})
      ON CONFLICT (workflow_id, snapshot_num) DO NOTHING
    `;
  });
}

// ── Cases ─────────────────────────────────────────────────────────────────────

export async function pgUpsertCase(c: CaseRecord): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await sql`
      INSERT INTO cases (case_id, process_id, version, subject, status, position, payload, history, updated_at)
      VALUES (
        ${c.case_id}, ${c.process_id}, ${c.version || null},
        ${c.subject}, ${c.status}, ${c.position || null},
        ${sql.json(asJson(c.payload ?? {}))},
        ${sql.json(asJson(c.history ?? []))},
        ${c.updated_at ? new Date(c.updated_at) : new Date()}
      )
      ON CONFLICT (case_id) DO UPDATE SET
        status     = EXCLUDED.status,
        position   = EXCLUDED.position,
        payload    = EXCLUDED.payload,
        history    = EXCLUDED.history,
        updated_at = EXCLUDED.updated_at
    `;
  });
}

// ── Work Items ────────────────────────────────────────────────────────────────

export async function pgUpsertWorkItem(wi: WorkItemRecord): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await sql`
      INSERT INTO work_items (
        id, case_id, process_id, element_id, label, assignee, status,
        input, output, deadline, updated_at
      ) VALUES (
        ${wi.id}, ${wi.case_id || null}, ${wi.process_id || null},
        ${wi.element_id || null}, ${wi.label},
        ${wi.assignee || null}, ${wi.status},
        ${sql.json(asJson(wi.input ?? {}))},
        ${sql.json(asJson(wi.output ?? {}))},
        ${wi.deadline ? new Date(wi.deadline) : null},
        ${wi.updated_at ? new Date(wi.updated_at) : new Date()}
      )
      ON CONFLICT (id) DO UPDATE SET
        status     = EXCLUDED.status,
        assignee   = EXCLUDED.assignee,
        output     = EXCLUDED.output,
        deadline   = EXCLUDED.deadline,
        updated_at = EXCLUDED.updated_at
    `;
  });
}

export async function pgDeleteWorkItem(id: string): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await sql`DELETE FROM work_items WHERE id = ${id}`;
  });
}

export async function pgPurgeAllWorkItems(): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await sql`DELETE FROM work_items`;
  });
}

// ── Roles ─────────────────────────────────────────────────────────────────────

export async function pgUpsertRole(r: RoleRecord): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await sql`
      INSERT INTO roles (id, name, description, assignees, strategy, updated_at)
      VALUES (
        ${r.id}, ${r.name}, ${r.description || null},
        ${sql.json(asJson(r.assignees ?? []))}, ${r.strategy || 'manual'},
        ${r.updated_at ? new Date(r.updated_at) : new Date()}
      )
      ON CONFLICT (id) DO UPDATE SET
        name        = EXCLUDED.name,
        description = EXCLUDED.description,
        assignees   = EXCLUDED.assignees,
        strategy    = EXCLUDED.strategy,
        updated_at  = EXCLUDED.updated_at
    `;
  });
}

export async function pgDeleteRole(id: string): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await sql`DELETE FROM roles WHERE id = ${id}`;
  });
}

// ── Documents ─────────────────────────────────────────────────────────────────

export async function pgUpsertDoc(d: DocRecord): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await sql`
      INSERT INTO documents (id, name, type, content, parameters, updated_at)
      VALUES (
        ${d.id}, ${d.name}, ${d.type || 'template'}, ${d.content || ''},
        ${sql.json(asJson(d.parameters ?? {}))},
        ${d.updated_at ? new Date(d.updated_at) : new Date()}
      )
      ON CONFLICT (id) DO UPDATE SET
        name       = EXCLUDED.name,
        type       = EXCLUDED.type,
        content    = EXCLUDED.content,
        parameters = EXCLUDED.parameters,
        updated_at = EXCLUDED.updated_at
    `;
  });
}

export async function pgDeleteDoc(id: string): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await sql`DELETE FROM documents WHERE id = ${id}`;
  });
}

// ── Reminders ─────────────────────────────────────────────────────────────────

export async function pgUpsertReminder(r: ReminderRecord): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await sql`
      INSERT INTO reminders (
        id, type, recipient, message, scheduled_at, channel, status,
        case_id, process_id, element_id, work_item_id, updated_at
      ) VALUES (
        ${r.id}, ${r.type || 'once'}, ${r.recipient}, ${r.message},
        ${new Date(r.scheduled_at)}, ${r.channel || 'telegram'}, ${r.status || 'pending'},
        ${r.case_id || null}, ${r.process_id || null},
        ${r.element_id || null}, ${r.work_item_id || null},
        ${r.updated_at ? new Date(r.updated_at) : new Date()}
      )
      ON CONFLICT (id) DO UPDATE SET
        status       = EXCLUDED.status,
        scheduled_at = EXCLUDED.scheduled_at,
        updated_at   = EXCLUDED.updated_at
    `;
  });
}

export async function pgDeleteReminder(id: string): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await sql`DELETE FROM reminders WHERE id = ${id}`;
  });
}

// ── Skills ────────────────────────────────────────────────────────────────────

export async function pgUpsertSkill(s: SkillRecord): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await sql`
      INSERT INTO skills (id, name, name_en, description, prompt_snippet, tools, mcp_servers, updated_at)
      VALUES (
        ${s.id}, ${s.name}, ${s.name_en || null},
        ${s.description || null}, ${s.prompt_snippet || null},
        ${sql.json(asJson(s.tools ?? []))},
        ${sql.json(asJson(s.mcp_servers ?? []))},
        ${s.updated_at ? new Date(s.updated_at) : new Date()}
      )
      ON CONFLICT (id) DO UPDATE SET
        name           = EXCLUDED.name,
        name_en        = EXCLUDED.name_en,
        description    = EXCLUDED.description,
        prompt_snippet = EXCLUDED.prompt_snippet,
        tools          = EXCLUDED.tools,
        mcp_servers    = EXCLUDED.mcp_servers,
        updated_at     = EXCLUDED.updated_at
    `;
  });
}

export async function pgDeleteSkill(id: string): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await sql`DELETE FROM skills WHERE id = ${id}`;
  });
}

// ── Read functions (Phase 2 — PG as primary read) ─────────────────────────────

// Safe read wrapper: returns null on error (never throws)
async function pgRead<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e: any) {
    log.error("read error", { error: e.message });
    return null;
  }
}

// ── Workflows ─────────────────────────────────────────────────────────────────

export async function pgGetWorkflow(id: string): Promise<Record<string, unknown> | null> {
  return pgRead(async () => {
    const sql = getSql();
    await ensureWorkflowLifecycleColumns(sql);
    const rows = await sql`SELECT * FROM workflows WHERE id = ${id}`;
    return (rows[0] as Record<string, unknown>) ?? null;
  });
}

export async function pgListWorkflows(): Promise<Record<string, unknown>[]> {
  return (await pgRead(async () => {
    const sql = getSql();
    await ensureWorkflowLifecycleColumns(sql);
    const rows = await sql`
      SELECT * FROM workflows
      WHERE COALESCE(lifecycle_state, status) <> 'retired'
      ORDER BY updated_at ASC
    `;
    return rows as Record<string, unknown>[];
  })) ?? [];
}

// ── Cases ─────────────────────────────────────────────────────────────────────

export async function pgGetCase(case_id: string): Promise<Record<string, unknown> | null> {
  return pgRead(async () => {
    const sql = getSql();
    const rows = await sql`SELECT * FROM cases WHERE case_id = ${case_id}`;
    return (rows[0] as Record<string, unknown>) ?? null;
  });
}

export async function pgListCases(filters: {
  status?: string;
  process_id?: string;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
}): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const result = await pgRead(async () => {
    const sql = getSql();
    const { status, process_id, after, before } = filters;
    const rows = await sql`
      SELECT * FROM cases
      WHERE ${status     ? sql`status     = ${status}`          : sql`TRUE`}
        AND ${process_id ? sql`process_id = ${process_id}`      : sql`TRUE`}
        AND ${after      ? sql`created_at >= ${new Date(after)}` : sql`TRUE`}
        AND ${before     ? sql`created_at <= ${new Date(before)}` : sql`TRUE`}
      ORDER BY created_at ASC
    `;
    return rows as Record<string, unknown>[];
  });
  const all = result ?? [];
  const total = all.length;
  const offset = filters.offset ?? 0;
  const limit  = filters.limit  ?? 50;
  return { rows: all.slice(offset, offset + limit), total };
}

export async function pgDeleteCasesByProcess(process_id: string): Promise<number> {
  return pgRead(async () => {
    const sql = getSql();
    const result = await sql`DELETE FROM cases WHERE process_id = ${process_id}`;
    return (result as any).count ?? 0;
  }) ?? 0;
}

export async function pgDeleteCase(case_id: string): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await sql`DELETE FROM cases WHERE case_id = ${case_id}`;
  });
}

// ── Work Items ────────────────────────────────────────────────────────────────

export async function pgGetWorkItem(id: string): Promise<Record<string, unknown> | null> {
  return pgRead(async () => {
    const sql = getSql();
    const rows = await sql`SELECT * FROM work_items WHERE id = ${id}`;
    return (rows[0] as Record<string, unknown>) ?? null;
  });
}

export async function pgListWorkItems(filters: {
  assignee?: string;
  status?: string;
  process_id?: string;
  case_id?: string;
  deadline_before?: string;
}): Promise<Record<string, unknown>[]> {
  return (await pgRead(async () => {
    const sql = getSql();
    const { assignee, status, process_id, case_id, deadline_before } = filters;
    const rows = await sql`
      SELECT * FROM work_items
      WHERE ${assignee        ? sql`assignee   = ${assignee}`                        : sql`TRUE`}
        AND ${status          ? sql`status     = ${status}`                          : sql`TRUE`}
        AND ${process_id      ? sql`process_id = ${process_id}`                      : sql`TRUE`}
        AND ${case_id         ? sql`case_id    = ${case_id}`                         : sql`TRUE`}
        AND ${deadline_before ? sql`deadline  <= ${new Date(deadline_before)}`       : sql`TRUE`}
      ORDER BY created_at ASC
    `;
    return rows as Record<string, unknown>[];
  })) ?? [];
}

// ── Roles ─────────────────────────────────────────────────────────────────────

export async function pgGetRole(id: string): Promise<Record<string, unknown> | null> {
  return pgRead(async () => {
    const sql = getSql();
    const rows = await sql`SELECT * FROM roles WHERE id = ${id}`;
    return (rows[0] as Record<string, unknown>) ?? null;
  });
}

export async function pgListRoles(): Promise<Record<string, unknown>[]> {
  return (await pgRead(async () => {
    const sql = getSql();
    const rows = await sql`SELECT * FROM roles ORDER BY created_at ASC`;
    return rows as Record<string, unknown>[];
  })) ?? [];
}

// ── Documents ─────────────────────────────────────────────────────────────────

export async function pgGetDoc(id: string): Promise<Record<string, unknown> | null> {
  return pgRead(async () => {
    const sql = getSql();
    const rows = await sql`SELECT * FROM documents WHERE id = ${id}`;
    return (rows[0] as Record<string, unknown>) ?? null;
  });
}

export async function pgListDocs(): Promise<Record<string, unknown>[]> {
  return (await pgRead(async () => {
    const sql = getSql();
    const rows = await sql`SELECT * FROM documents ORDER BY created_at ASC`;
    return rows as Record<string, unknown>[];
  })) ?? [];
}

// ── Reminders ─────────────────────────────────────────────────────────────────

export async function pgGetReminder(id: string): Promise<Record<string, unknown> | null> {
  return pgRead(async () => {
    const sql = getSql();
    const rows = await sql`SELECT * FROM reminders WHERE id = ${id}`;
    return (rows[0] as Record<string, unknown>) ?? null;
  });
}

export async function pgListReminders(filters: {
  status?: string;
}): Promise<Record<string, unknown>[]> {
  return (await pgRead(async () => {
    const sql = getSql();
    const { status } = filters;
    const rows = await sql`
      SELECT * FROM reminders
      WHERE ${status ? sql`status = ${status}` : sql`TRUE`}
      ORDER BY scheduled_at ASC
    `;
    return rows as Record<string, unknown>[];
  })) ?? [];
}
