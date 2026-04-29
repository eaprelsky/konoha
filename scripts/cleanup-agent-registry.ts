#!/usr/bin/env bun
/**
 * Safely prune ephemeral/test agent registry pollution.
 *
 * Default mode is dry-run. The only records deleted by --apply are generated
 * test rows (`rtest-*` and `test-...-t<timestamp>`), which must not persist in
 * production.
 */

import postgres from "postgres";
import Redis from "ioredis";
import { getDatabaseUrl } from "../src/storage/database-url";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const dryRun = args.has("--dry-run") || !apply;

if (args.has("--help") || args.has("-h")) {
  console.log(`usage: bun scripts/cleanup-agent-registry.ts [--dry-run|--apply]

Deletes generated test agent rows and their Redis stream keys when --apply is set.
Other suspicious ids are reported for manual review.`);
  process.exit(0);
}

const sql = postgres(getDatabaseUrl(), {
  max: 2,
  idle_timeout: 10,
  connect_timeout: 5,
  onnotice: () => {},
});
const redis = new Redis({ host: "127.0.0.1", port: 6379, db: Number(process.env.REDIS_DB ?? "0") });

type AgentRow = {
  id: string;
  name: string;
  status: string;
  updated_at: string;
};

function isSuspiciousNonRtest(id: string): boolean {
  const lowered = id.toLowerCase();
  return !isGeneratedTestAgentId(id) && ["test", "smoke", "verify"].some((part) => lowered.includes(part));
}

function isGeneratedTestAgentId(id: string): boolean {
  return id.startsWith("rtest-") || /^test(?:-[a-z0-9-]+)?-t\d+$/.test(id);
}

try {
  const generatedRows = await sql<AgentRow[]>`
    SELECT id, name, status, updated_at::text
    FROM konoha_agents
    WHERE id LIKE 'rtest-%'
       OR id ~ '^test(-[a-z0-9-]+)?-t[0-9]+$'
    ORDER BY id ASC
  `;
  const suspiciousRows = await sql<AgentRow[]>`
    SELECT id, name, status, updated_at::text
    FROM konoha_agents
    WHERE id NOT LIKE 'rtest-%'
      AND id !~ '^test(-[a-z0-9-]+)?-t[0-9]+$'
      AND (
        lower(id) LIKE '%test%'
        OR lower(id) LIKE '%smoke%'
        OR lower(id) LIKE '%verify%'
      )
    ORDER BY id ASC
  `;

  const streamKeys = [
    ...(await redis.keys("konoha:agent:rtest-*")),
    ...(await redis.keys("konoha:agent:test*-t*")),
  ];

  console.log(`mode=${dryRun ? "dry-run" : "apply"}`);
  console.log(`generated_test_agent_rows=${generatedRows.length}`);
  console.log(`generated_test_redis_streams=${streamKeys.length}`);
  console.log(`suspicious_non_rtest_rows=${suspiciousRows.length}`);
  if (suspiciousRows.length) {
    console.log("suspicious_non_rtest_sample=");
    for (const row of suspiciousRows.slice(0, 20)) {
      console.log(`  ${row.id}\t${row.status}\t${row.name}`);
    }
  }

  if (dryRun) {
    console.log("No changes made. Re-run with --apply to delete generated test rows and streams.");
    process.exit(0);
  }

  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM konoha_agents
      WHERE id LIKE 'rtest-%'
         OR id ~ '^test(-[a-z0-9-]+)?-t[0-9]+$'
    `;
  });
  if (streamKeys.length) {
    await redis.del(...new Set(streamKeys));
  }

  console.log(`deleted_generated_test_agent_rows=${generatedRows.length}`);
  console.log(`deleted_generated_test_redis_streams=${streamKeys.length}`);
  console.log("done");
} finally {
  await sql.end({ timeout: 5 });
  redis.disconnect();
}
