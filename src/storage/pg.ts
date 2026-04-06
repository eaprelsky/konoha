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
        ${sql.json(wf.elements ?? [])},
        ${sql.json(wf.flow ?? [])},
        ${sql.json((wf as any).triggers ?? [])},
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
      VALUES (${workflowId}, ${snapshotNum}, ${sql.json(data)}, ${savedAt})
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
        ${sql.json(c.payload ?? {})},
        ${sql.json(c.history ?? [])},
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
        ${sql.json(wi.input ?? {})},
        ${sql.json(wi.output ?? {})},
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
        ${sql.json(r.assignees ?? [])}, ${r.strategy || 'manual'},
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
        ${sql.json(d.parameters ?? {})},
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
        ${sql.json(s.tools ?? [])},
        ${sql.json(s.mcp_servers ?? [])},
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
