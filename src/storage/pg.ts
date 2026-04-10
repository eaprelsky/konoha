// PostgreSQL storage layer — Phase 1 shadow writes
// Strategy: write to BOTH Redis (primary) and PG (shadow).
// All reads still come from Redis. PG errors are logged, never surfaced.
//
// Connection: DATABASE_URL env var or default konoha@localhost/konoha

import postgres from "postgres";
import type {
  WorkflowRecord, CaseRecord, WorkItemRecord,
  RoleRecord, DocRecord, ReminderRecord, SkillRecord,
} from "./types";

// postgres's sql.json() requires JSONValue, but our domain types are structurally compatible
// at runtime. This helper centralises the cast instead of spreading `as any` everywhere.
type JSONValue = Parameters<ReturnType<typeof postgres>["json"]>[0];
const asJson = (v: unknown): JSONValue => v as JSONValue;

const DATABASE_URL = process.env.DATABASE_URL ||
  "postgres://konoha:konoha2026@127.0.0.1:5432/konoha";

let _sql: ReturnType<typeof postgres> | null = null;

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
    console.error("[pg:shadow] write error:", e.message);
  }
}

// ── Workflows ─────────────────────────────────────────────────────────────────

export async function pgUpsertWorkflow(wf: WorkflowRecord): Promise<void> {
  await pgWrite(async () => {
    const sql = getSql();
    await sql`
      INSERT INTO workflows (id, name, version, elements, flow, triggers, status, parent_id, updated_at)
      VALUES (
        ${wf.id}, ${wf.name || ''}, ${wf.version || '1.0.0'},
        ${sql.json(asJson(wf.elements ?? []))},
        ${sql.json(asJson(wf.flow ?? []))},
        ${sql.json(asJson((wf as any).triggers ?? []))},
        ${(wf as any).status || 'active'},
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
    console.error("[pg:read] error:", e.message);
    return null;
  }
}

// ── Workflows ─────────────────────────────────────────────────────────────────

export async function pgGetWorkflow(id: string): Promise<Record<string, unknown> | null> {
  return pgRead(async () => {
    const sql = getSql();
    const rows = await sql`SELECT * FROM workflows WHERE id = ${id}`;
    return (rows[0] as Record<string, unknown>) ?? null;
  });
}

export async function pgListWorkflows(): Promise<Record<string, unknown>[]> {
  return (await pgRead(async () => {
    const sql = getSql();
    const rows = await sql`SELECT * FROM workflows ORDER BY updated_at ASC`;
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
  deadline_before?: string;
}): Promise<Record<string, unknown>[]> {
  return (await pgRead(async () => {
    const sql = getSql();
    const { assignee, status, process_id, deadline_before } = filters;
    const rows = await sql`
      SELECT * FROM work_items
      WHERE ${assignee        ? sql`assignee   = ${assignee}`                        : sql`TRUE`}
        AND ${status          ? sql`status     = ${status}`                          : sql`TRUE`}
        AND ${process_id      ? sql`process_id = ${process_id}`                      : sql`TRUE`}
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
