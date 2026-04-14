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
import {
  pgRegisterAgent,
  pgStoreMessage,
} from "../src/storage/pg-bus";

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

async function migrateAgentsAndTokens() {
  const map = await redis.hgetall("konoha:registry");
  const tokensMap = await redis.hgetall("konoha:tokens");
  console.log(`Agents: ${Object.keys(map).length} keys`);
  let ok = 0, fail = 0;

  for (const raw of Object.values(map)) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed?.id) continue;
      if (!DRY_RUN) {
        const newToken = await pgRegisterAgent({
          id: parsed.id,
          name: parsed.name || parsed.id,
          capabilities: parsed.capabilities || [],
          roles: parsed.roles || [],
          model: parsed.model || undefined,
          status: parsed.status || "offline",
          lastHeartbeat: parsed.lastHeartbeat || Date.now(),
          eventSubscriptions: parsed.eventSubscriptions || [],
          village_id: parsed.village_id,
          address: parsed.address,
        });
        // Keep a visible log when token rotated by migration.
        const oldToken = Object.entries(tokensMap).find(([, v]) => v === parsed.id)?.[0];
        if (oldToken && oldToken !== newToken) {
          console.log(`  token rotated for ${parsed.id}`);
        }
      }
      ok++;
    } catch (e: any) {
      console.error("  FAIL agent:", e.message);
      fail++;
    }
  }
  console.log(`  ok=${ok} fail=${fail}`);
}

function toMessageFromFields(id: string, fields: string[]): Record<string, unknown> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
  let attachments: unknown[] = [];
  if (obj.attachments) {
    try { attachments = JSON.parse(obj.attachments); } catch {}
  }
  return {
    id,
    from: obj.from || "unknown",
    to: obj.to || "unknown",
    channel: obj.channel,
    type: obj.type || "message",
    text: obj.text || "",
    replyTo: obj.replyTo,
    timestamp: obj.timestamp || new Date().toISOString(),
    attachments,
    village_id: obj.village_id,
  };
}

async function migrateMessageHistory() {
  const agentStreams = await scanKeys("konoha:agent:*");
  const channelStreams = await scanKeys("konoha:channel:*");
  const streams = [...agentStreams, ...channelStreams];
  console.log(`Message streams: ${streams.length} keys`);
  let ok = 0, fail = 0;
  for (const stream of streams) {
    try {
      const entries = await redis.xrange(stream, "-", "+");
      for (const [id, fields] of entries) {
        const msg = toMessageFromFields(id, fields);
        if (!DRY_RUN) {
          await pgStoreMessage({
            id: String(msg.id),
            from: String(msg.from),
            to: String(msg.to),
            type: String(msg.type) as any,
            text: String(msg.text),
            channel: msg.channel ? String(msg.channel) : undefined,
            replyTo: msg.replyTo ? String(msg.replyTo) : undefined,
            timestamp: String(msg.timestamp),
            attachments: Array.isArray(msg.attachments) ? msg.attachments as any[] : undefined,
            village_id: msg.village_id ? String(msg.village_id) : undefined,
          });
        }
        ok++;
      }
    } catch (e: any) {
      console.error(`  FAIL stream ${stream}:`, e.message);
      fail++;
    }
  }
  console.log(`  ok=${ok} fail=${fail}`);
}

async function verify() {
  const { default: postgres } = await import("postgres");
  const { getDatabaseUrl } = await import("../src/storage/database-url");
  const sql = postgres(getDatabaseUrl());
  const [wf] = await sql`SELECT COUNT(*)::int AS n FROM workflows`;
  const [ca] = await sql`SELECT COUNT(*)::int AS n FROM cases`;
  const [wi] = await sql`SELECT COUNT(*)::int AS n FROM work_items`;
  const [ro] = await sql`SELECT COUNT(*)::int AS n FROM roles`;
  const [do_] = await sql`SELECT COUNT(*)::int AS n FROM documents`;
  const [re] = await sql`SELECT COUNT(*)::int AS n FROM reminders`;
  const [sk] = await sql`SELECT COUNT(*)::int AS n FROM skills`;
  const [ag] = await sql`SELECT COUNT(*)::int AS n FROM konoha_agents`;
  const [msg] = await sql`SELECT COUNT(*)::int AS n FROM konoha_messages`;
  console.log("\n=== PostgreSQL row counts ===");
  console.log(`  workflows:   ${wf.n}`);
  console.log(`  cases:       ${ca.n}`);
  console.log(`  work_items:  ${wi.n}`);
  console.log(`  roles:       ${ro.n}`);
  console.log(`  documents:   ${do_.n}`);
  console.log(`  reminders:   ${re.n}`);
  console.log(`  skills:      ${sk.n}`);
  console.log(`  agents:      ${ag.n}`);
  console.log(`  messages:    ${msg.n}`);
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
  await migrateAgentsAndTokens();
  await migrateMessageHistory();
  console.log("\nDone.");
  if (!DRY_RUN) await verify();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
