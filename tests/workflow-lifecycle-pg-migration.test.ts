import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { createTestPostgres, getTestPgSchema } from "./pg-test-utils";

const sql = createTestPostgres({
  max: 1,
  idle_timeout: 5,
  connect_timeout: 5,
  onnotice: () => {},
});
const schema = `${getTestPgSchema()}_workflow_lifecycle_${process.pid}`.replace(/[^a-zA-Z0-9_]/g, "_");

afterAll(async () => {
  await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
  await sql.end();
});

describe("workflow lifecycle PostgreSQL migration", () => {
  test("backfills lifecycle state from legacy status before trusting defaulted lifecycle_state", async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql`CREATE SCHEMA ${sql(schema)}`;
    await sql`SET search_path TO ${sql(schema)}, public`;
    await sql`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '1.0.0',
        elements JSONB NOT NULL DEFAULT '[]',
        flow JSONB NOT NULL DEFAULT '[]',
        triggers JSONB NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        parent_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    for (const status of ["draft", "needs_review", "archived", "deleted", "active", "executable"]) {
      await sql`
        INSERT INTO workflows (id, status)
        VALUES (${`legacy-${status}`}, ${status})
      `;
    }

    const schemaSql = readFileSync(new URL("../src/storage/schema.sql", import.meta.url), "utf-8")
      .replace(/^CREATE EXTENSION IF NOT EXISTS "uuid-ossp";\s*$/m, "");
    await sql.unsafe(schemaSql);

    const rows = await sql`
      SELECT id, status, lifecycle_state, lifecycle
      FROM workflows
      ORDER BY id
    ` as unknown as Array<{ id: string; status: string; lifecycle_state: string; lifecycle: Record<string, unknown> }>;
    const byId = new Map(rows.map(row => [row.id, row]));

    expect(byId.get("legacy-draft")).toMatchObject({ status: "draft", lifecycle_state: "draft" });
    expect(byId.get("legacy-needs_review")).toMatchObject({ status: "validated", lifecycle_state: "validated" });
    expect(byId.get("legacy-archived")).toMatchObject({ status: "retired", lifecycle_state: "retired" });
    expect(byId.get("legacy-deleted")).toMatchObject({ status: "retired", lifecycle_state: "retired" });
    expect(byId.get("legacy-active")).toMatchObject({ status: "executable", lifecycle_state: "executable" });
    expect(byId.get("legacy-executable")).toMatchObject({ status: "executable", lifecycle_state: "executable" });

    expect(byId.get("legacy-archived")?.lifecycle).toMatchObject({
      schema_version: 1,
      state: "retired",
      status: "retired",
      migrated_from_status: "archived",
    });

    const activeRows = await sql`
      SELECT id FROM workflows
      WHERE COALESCE(lifecycle_state, status) <> 'retired'
      ORDER BY id
    ` as unknown as Array<{ id: string }>;
    expect(activeRows.map(row => row.id)).not.toContain("legacy-archived");
    expect(activeRows.map(row => row.id)).not.toContain("legacy-deleted");
  });
});
