#!/usr/bin/env bun
/**
 * Migration script: Redis → PostgreSQL
 * Reads all business data from Redis using SCAN, writes to PostgreSQL.
 *
 * Usage:
 *   bun run scripts/migrate-redis-to-pg.ts [--dry-run]
 *
 * Safe to run multiple times (upsert semantics).
 */

import { redis } from "../src/redis";
import {
  pgUpsertWorkflow, pgSaveWorkflowSnapshot,
  pgUpsertCase, pgUpsertWorkItem,
  pgUpsertRole, pgUpsertDoc, pgUpsertReminder, pgUpsertSkill,
} from "../src/storage/pg";

const DRY_RUN = process.argv.includes("--dry-run");

async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = 0;
  do {
    const [nextCursor, batch] = await (redis as any).scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = Number(nextCursor);
    keys.push(...batch);
  } while (cursor !== 0);
  return keys;
}

async function migrateWorkflows() {
  const keys = await scanKeys("workflow:*");
  const wfKeys = keys.filter(k => k.startsWith("workflow:") && !k.includes(":version:") && !k.startsWith("konoha:workflow:"));
  console.log(`Workflows: ${wfKeys.length} keys`);
  let ok = 0, fail = 0;
  for (const key of wfKeys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      const wf = JSON.parse(raw);
      if (!wf.id) continue;
      if (!DRY_RUN) await pgUpsertWorkflow(wf);
      ok++;
    } catch (e: any) {
      console.error(`  FAIL ${key}:`, e.message);
      fail++;
    }
  }
  console.log(`  ok=${ok} fail=${fail}`);
}

async function migrateWorkflowSnapshots() {
  const keys = await scanKeys("workflow:version:*");
  console.log(`Workflow snapshots: ${keys.length} keys`);
  let ok = 0, fail = 0;
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      // key format: workflow:version:{id}:v{N}
      const match = key.match(/^workflow:version:(.+):v(\d+)$/);
      if (!match) continue;
      const [, workflowId, snapshotNum] = match;
      if (!DRY_RUN) await pgSaveWorkflowSnapshot(workflowId, Number(snapshotNum), data);
      ok++;
    } catch (e: any) {
      console.error(`  FAIL ${key}:`, e.message);
      fail++;
    }
  }
  console.log(`  ok=${ok} fail=${fail}`);
}

async function migrateCases() {
  const keys = await scanKeys("case:*");
  console.log(`Cases: ${keys.length} keys`);
  let ok = 0, fail = 0;
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      const c = JSON.parse(raw);
      if (!c.case_id) continue;
      if (!DRY_RUN) await pgUpsertCase({
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
      ok++;
    } catch (e: any) {
      console.error(`  FAIL ${key}:`, e.message);
      fail++;
    }
  }
  console.log(`  ok=${ok} fail=${fail}`);
}

async function migrateWorkItems() {
  const keys = await scanKeys("workitem:*");
  console.log(`WorkItems: ${keys.length} keys`);
  let ok = 0, fail = 0;
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      const wi = JSON.parse(raw);
      if (!wi.work_item_id) continue;
      if (!DRY_RUN) await pgUpsertWorkItem({
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
      ok++;
    } catch (e: any) {
      console.error(`  FAIL ${key}:`, e.message);
      fail++;
    }
  }
  console.log(`  ok=${ok} fail=${fail}`);
}

async function migrateRoles() {
  const keys = await scanKeys("role:*");
  console.log(`Roles: ${keys.length} keys`);
  let ok = 0, fail = 0;
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      const r = JSON.parse(raw);
      if (!r.role_id) continue;
      if (!DRY_RUN) await pgUpsertRole({
        id: r.role_id,
        name: r.name || '',
        description: r.description,
        assignees: r.assignees || [],
        strategy: r.strategy || 'manual',
        updated_at: r.updated_at || r.created_at,
      });
      ok++;
    } catch (e: any) {
      console.error(`  FAIL ${key}:`, e.message);
      fail++;
    }
  }
  console.log(`  ok=${ok} fail=${fail}`);
}

async function migrateDocs() {
  const keys = await scanKeys("doc:*");
  console.log(`Documents: ${keys.length} keys`);
  let ok = 0, fail = 0;
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      const d = JSON.parse(raw);
      if (!d.doc_id) continue;
      if (!DRY_RUN) await pgUpsertDoc({
        id: d.doc_id,
        name: d.name || '',
        type: d.type || 'template',
        content: d.content || '',
        parameters: {},
        updated_at: d.updated_at || d.created_at,
      });
      ok++;
    } catch (e: any) {
      console.error(`  FAIL ${key}:`, e.message);
      fail++;
    }
  }
  console.log(`  ok=${ok} fail=${fail}`);
}

async function migrateReminders() {
  const allKeys = await scanKeys("reminder:*");
  // Skip non-UUID keys (streams, command queues, etc.)
  const keys = allKeys.filter(k => /^reminder:[0-9a-f-]{36}$/.test(k));
  console.log(`Reminders: ${keys.length} keys`);
  let ok = 0, fail = 0;
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      const r = JSON.parse(raw);
      if (!r.reminder_id) continue;
      if (!DRY_RUN) await pgUpsertReminder({
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
      ok++;
    } catch (e: any) {
      console.error(`  FAIL ${key}:`, e.message);
      fail++;
    }
  }
  console.log(`  ok=${ok} fail=${fail}`);
}

async function migrateSkills() {
  const keys = await scanKeys("konoha:skill:*");
  console.log(`Skills: ${keys.length} keys`);
  let ok = 0, fail = 0;
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      const s = JSON.parse(raw);
      if (!s.id) continue;
      if (!DRY_RUN) await pgUpsertSkill(s);
      ok++;
    } catch (e: any) {
      console.error(`  FAIL ${key}:`, e.message);
      fail++;
    }
  }
  console.log(`  ok=${ok} fail=${fail}`);
}

async function verify() {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL || "postgres://konoha:konoha2026@127.0.0.1:5432/konoha");
  const [wf] = await sql`SELECT COUNT(*)::int AS n FROM workflows`;
  const [ca] = await sql`SELECT COUNT(*)::int AS n FROM cases`;
  const [wi] = await sql`SELECT COUNT(*)::int AS n FROM work_items`;
  const [ro] = await sql`SELECT COUNT(*)::int AS n FROM roles`;
  const [do_] = await sql`SELECT COUNT(*)::int AS n FROM documents`;
  const [re] = await sql`SELECT COUNT(*)::int AS n FROM reminders`;
  const [sk] = await sql`SELECT COUNT(*)::int AS n FROM skills`;
  console.log("\n=== PostgreSQL row counts ===");
  console.log(`  workflows:   ${wf.n}`);
  console.log(`  cases:       ${ca.n}`);
  console.log(`  work_items:  ${wi.n}`);
  console.log(`  roles:       ${ro.n}`);
  console.log(`  documents:   ${do_.n}`);
  console.log(`  reminders:   ${re.n}`);
  console.log(`  skills:      ${sk.n}`);
  await sql.end();
}

async function main() {
  console.log(`=== Redis → PostgreSQL migration ${DRY_RUN ? "(DRY RUN)" : ""} ===\n`);
  await migrateWorkflows();
  await migrateWorkflowSnapshots();
  await migrateCases();
  await migrateWorkItems();
  await migrateRoles();
  await migrateDocs();
  await migrateReminders();
  await migrateSkills();
  console.log("\nDone.");
  if (!DRY_RUN) await verify();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
