#!/usr/bin/env bun
/**
 * pg-sync.ts — синхронизация PG с Redis (Redis → source of truth)
 *
 * Стратегия:
 *   1. Читает tracking-индексы Redis (konoha:cases:all, konoha:workitems:all, etc.)
 *   2. Читает IDs из PG
 *   3. Удаляет из PG записи, которых нет в Redis
 *   4. Записывает в PG записи, которые есть в Redis но нет в PG
 *
 * Флаги:
 *   --dry-run   только показать что будет сделано, не изменять данные
 *   --no-delete не удалять PG-only записи (только backfill)
 *
 * Запуск:
 *   cd /home/ubuntu/konoha && bun run scripts/pg-sync.ts [--dry-run] [--no-delete]
 */

import Redis from "ioredis";
import postgres from "postgres";
import {
  pgUpsertCase, pgUpsertWorkItem, pgUpsertWorkflow,
  pgUpsertRole, pgUpsertDoc, pgUpsertReminder,
  pgDeleteWorkflow,
} from "../src/storage/pg";
import { getDatabaseUrl } from "../src/storage/database-url";

const DATABASE_URL = getDatabaseUrl();

const redis = new Redis({ host: "127.0.0.1", port: 6379, db: 0 });
const sql = postgres(DATABASE_URL, { max: 5, idle_timeout: 10, connect_timeout: 5, onnotice: () => {} });

const DRY_RUN  = process.argv.includes("--dry-run");
const NO_DELETE = process.argv.includes("--no-delete");

if (DRY_RUN)   console.log("[pg-sync] DRY RUN — no changes will be made");
if (NO_DELETE) console.log("[pg-sync] --no-delete — skipping PG-only deletions");

interface SyncResult {
  entity: string;
  deleted: number;
  backfilled: number;
  errors: number;
}

// ── Cases ─────────────────────────────────────────────────────────────────────

async function syncCases(): Promise<SyncResult> {
  const redisIds = new Set(await redis.zrange("konoha:cases:all", 0, -1));
  const pgRows = await sql<{ case_id: string }[]>`SELECT case_id FROM cases`;
  const pgIds = new Set(pgRows.map(r => r.case_id));

  let deleted = 0, backfilled = 0, errors = 0;

  // Delete PG-only records
  if (!NO_DELETE) {
    for (const id of pgIds) {
      if (!redisIds.has(id)) {
        console.log(`  [cases] DELETE PG-only ${id}`);
        if (!DRY_RUN) {
          try { await sql`DELETE FROM cases WHERE case_id = ${id}`; deleted++; }
          catch (e: any) { console.error(`    ERROR: ${e.message}`); errors++; }
        } else { deleted++; }
      }
    }
  }

  // Backfill Redis-only records to PG
  for (const id of redisIds) {
    if (!pgIds.has(id)) {
      const raw = await redis.get(`case:${id}`);
      if (!raw) { console.warn(`  [cases] Redis key case:${id} missing (orphan in index)`); continue; }
      try {
        const c = JSON.parse(raw);
        console.log(`  [cases] BACKFILL ${id}`);
        if (!DRY_RUN) {
          await pgUpsertCase({
            case_id: c.case_id,
            process_id: c.process_id,
            version: c.process_version,
            subject: c.subject || '',
            status: c.status || 'running',
            position: c.position,
            payload: c.payload || {},
            history: c.history || [],
            created_at: c.created_at,
            updated_at: c.updated_at || c.created_at,
          });
        }
        backfilled++;
      } catch (e: any) { console.error(`  [cases] BACKFILL ERROR ${id}: ${e.message}`); errors++; }
    }
  }

  return { entity: "cases", deleted, backfilled, errors };
}

// ── Work Items ────────────────────────────────────────────────────────────────

async function syncWorkItems(): Promise<SyncResult> {
  const redisIds = new Set(await redis.zrange("konoha:workitems:all", 0, -1));
  const pgRows = await sql<{ id: string }[]>`SELECT id FROM work_items`;
  const pgIds = new Set(pgRows.map(r => r.id));

  let deleted = 0, backfilled = 0, errors = 0;

  if (!NO_DELETE) {
    for (const id of pgIds) {
      if (!redisIds.has(id)) {
        console.log(`  [work_items] DELETE PG-only ${id}`);
        if (!DRY_RUN) {
          try { await sql`DELETE FROM work_items WHERE id = ${id}`; deleted++; }
          catch (e: any) { console.error(`    ERROR: ${e.message}`); errors++; }
        } else { deleted++; }
      }
    }
  }

  for (const id of redisIds) {
    if (!pgIds.has(id)) {
      const raw = await redis.get(`workitem:${id}`);
      if (!raw) { console.warn(`  [work_items] Redis key workitem:${id} missing`); continue; }
      try {
        const wi = JSON.parse(raw);
        console.log(`  [work_items] BACKFILL ${id}`);
        if (!DRY_RUN) {
          await pgUpsertWorkItem({
            id: wi.work_item_id,
            case_id: wi.case_id,
            process_id: wi.process_id,
            element_id: wi.element_id,
            label: wi.label || '',
            assignee: wi.assignee,
            status: wi.status || 'pending',
            input: wi.input || {},
            output: wi.output || {},
            deadline: wi.deadline,
            created_at: wi.created_at,
            updated_at: wi.updated_at || wi.created_at,
          });
        }
        backfilled++;
      } catch (e: any) { console.error(`  [work_items] BACKFILL ERROR ${id}: ${e.message}`); errors++; }
    }
  }

  return { entity: "work_items", deleted, backfilled, errors };
}

// ── Workflows ─────────────────────────────────────────────────────────────────

async function syncWorkflows(): Promise<SyncResult> {
  const redisIds = new Set(await redis.smembers("konoha:workflow:index"));
  const pgRows = await sql<{ id: string }[]>`SELECT id FROM workflows`;
  const pgIds = new Set(pgRows.map(r => r.id));

  let deleted = 0, backfilled = 0, errors = 0;

  if (!NO_DELETE) {
    for (const id of pgIds) {
      if (!redisIds.has(id)) {
        console.log(`  [workflows] DELETE PG-only ${id}`);
        if (!DRY_RUN) {
          try { await pgDeleteWorkflow(id); deleted++; }
          catch (e: any) { console.error(`    ERROR: ${e.message}`); errors++; }
        } else { deleted++; }
      }
    }
  }

  for (const id of redisIds) {
    if (!pgIds.has(id)) {
      const raw = await redis.get(`workflow:${id}`);
      if (!raw) { console.warn(`  [workflows] Redis key workflow:${id} missing`); continue; }
      try {
        const wf = JSON.parse(raw);
        console.log(`  [workflows] BACKFILL ${id}`);
        if (!DRY_RUN) await pgUpsertWorkflow(wf);
        backfilled++;
      } catch (e: any) { console.error(`  [workflows] BACKFILL ERROR ${id}: ${e.message}`); errors++; }
    }
  }

  return { entity: "workflows", deleted, backfilled, errors };
}

// ── Roles ─────────────────────────────────────────────────────────────────────

async function syncRoles(): Promise<SyncResult> {
  const redisIds = new Set(await redis.zrange("konoha:roles:all", 0, -1));
  const pgRows = await sql<{ id: string }[]>`SELECT id FROM roles`;
  const pgIds = new Set(pgRows.map(r => r.id));

  let deleted = 0, backfilled = 0, errors = 0;

  if (!NO_DELETE) {
    for (const id of pgIds) {
      if (!redisIds.has(id)) {
        console.log(`  [roles] DELETE PG-only ${id}`);
        if (!DRY_RUN) {
          try { await sql`DELETE FROM roles WHERE id = ${id}`; deleted++; }
          catch (e: any) { console.error(`    ERROR: ${e.message}`); errors++; }
        } else { deleted++; }
      }
    }
  }

  for (const id of redisIds) {
    if (!pgIds.has(id)) {
      const raw = await redis.get(`role:${id}`);
      if (!raw) { console.warn(`  [roles] Redis key role:${id} missing`); continue; }
      try {
        const r = JSON.parse(raw);
        console.log(`  [roles] BACKFILL ${id}`);
        if (!DRY_RUN) {
          await pgUpsertRole({
            id: r.role_id,
            name: r.name || '',
            description: r.description,
            assignees: r.assignees || [],
            strategy: r.strategy || 'manual',
            updated_at: r.updated_at || r.created_at,
          });
        }
        backfilled++;
      } catch (e: any) { console.error(`  [roles] BACKFILL ERROR ${id}: ${e.message}`); errors++; }
    }
  }

  return { entity: "roles", deleted, backfilled, errors };
}

// ── Documents ─────────────────────────────────────────────────────────────────

async function syncDocs(): Promise<SyncResult> {
  const redisIds = new Set(await redis.zrange("konoha:docs:all", 0, -1));
  const pgRows = await sql<{ id: string }[]>`SELECT id FROM documents`;
  const pgIds = new Set(pgRows.map(r => r.id));

  let deleted = 0, backfilled = 0, errors = 0;

  if (!NO_DELETE) {
    for (const id of pgIds) {
      if (!redisIds.has(id)) {
        console.log(`  [documents] DELETE PG-only ${id}`);
        if (!DRY_RUN) {
          try { await sql`DELETE FROM documents WHERE id = ${id}`; deleted++; }
          catch (e: any) { console.error(`    ERROR: ${e.message}`); errors++; }
        } else { deleted++; }
      }
    }
  }

  for (const id of redisIds) {
    if (!pgIds.has(id)) {
      const raw = await redis.get(`doc:${id}`);
      if (!raw) { console.warn(`  [documents] Redis key doc:${id} missing`); continue; }
      try {
        const d = JSON.parse(raw);
        console.log(`  [documents] BACKFILL ${id}`);
        if (!DRY_RUN) {
          const { pgUpsertDoc } = await import("../src/storage/pg");
          await pgUpsertDoc({
            id: d.doc_id,
            name: d.name || '',
            type: d.type || 'template',
            content: d.content || '',
            parameters: {},
            updated_at: d.updated_at || d.created_at,
          });
        }
        backfilled++;
      } catch (e: any) { console.error(`  [documents] BACKFILL ERROR ${id}: ${e.message}`); errors++; }
    }
  }

  return { entity: "documents", deleted, backfilled, errors };
}

// ── Reminders ─────────────────────────────────────────────────────────────────

async function syncReminders(): Promise<SyncResult> {
  const redisIds = new Set(await redis.zrange("konoha:reminders:all", 0, -1));
  const pgRows = await sql<{ id: string }[]>`SELECT id FROM reminders`;
  const pgIds = new Set(pgRows.map(r => r.id));

  let deleted = 0, backfilled = 0, errors = 0;

  if (!NO_DELETE) {
    for (const id of pgIds) {
      if (!redisIds.has(id)) {
        console.log(`  [reminders] DELETE PG-only ${id}`);
        if (!DRY_RUN) {
          try { await sql`DELETE FROM reminders WHERE id = ${id}`; deleted++; }
          catch (e: any) { console.error(`    ERROR: ${e.message}`); errors++; }
        } else { deleted++; }
      }
    }
  }

  for (const id of redisIds) {
    if (!pgIds.has(id)) {
      const raw = await redis.get(`reminder:${id}`);
      if (!raw) { console.warn(`  [reminders] Redis key reminder:${id} missing`); continue; }
      try {
        const r = JSON.parse(raw);
        console.log(`  [reminders] BACKFILL ${id}`);
        if (!DRY_RUN) {
          await pgUpsertReminder({
            id: r.reminder_id,
            type: r.type || 'once',
            recipient: r.recipient || '',
            message: r.message || '',
            scheduled_at: r.scheduled_at,
            channel: r.channel || 'telegram',
            status: r.status || 'pending',
            case_id: r.case_id,
            process_id: r.process_id,
            element_id: r.element_id,
            work_item_id: r.work_item_id,
            updated_at: r.updated_at || r.created_at,
          });
        }
        backfilled++;
      } catch (e: any) { console.error(`  [reminders] BACKFILL ERROR ${id}: ${e.message}`); errors++; }
    }
  }

  return { entity: "reminders", deleted, backfilled, errors };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Konoha PG Sync (Redis → PG) ===");
  console.log(`DB: ${DATABASE_URL.replace(/:\/\/[^@]+@/, "://<creds>@")}`);

  try {
    const results = await Promise.all([
      syncCases(),
      syncWorkItems(),
      syncWorkflows(),
      syncRoles(),
      syncDocs(),
      syncReminders(),
    ]);

    let totalDeleted = 0, totalBackfilled = 0, totalErrors = 0;
    console.log("\n=== Summary ===");
    for (const r of results) {
      console.log(`  ${r.entity}: deleted=${r.deleted} backfilled=${r.backfilled} errors=${r.errors}`);
      totalDeleted   += r.deleted;
      totalBackfilled += r.backfilled;
      totalErrors    += r.errors;
    }
    console.log(`\nTotal: deleted=${totalDeleted} backfilled=${totalBackfilled} errors=${totalErrors}`);

    if (DRY_RUN) console.log("\nDRY RUN — re-run without --dry-run to apply changes");
    else console.log("\nDone. Run scripts/pg-verify.ts to confirm sync.");

    process.exit(totalErrors > 0 ? 1 : 0);
  } finally {
    redis.disconnect();
    await sql.end();
  }
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
