/**
 * schema-registry-sync.ts — Sync schema entities to the registry on deploy.
 * Implements phase 1 of #407 (schema→registry, no bidirectional rename sync).
 *
 * Called on createWorkflow / updateWorkflow to ensure roles, documents, and
 * information systems referenced in the schema exist in the registry.
 */
import { redis } from "../redis";
import { loadRole, createRole } from "../runtime/roles";
import type { WorkflowDefinition } from "../workflow-loader";

export interface SyncResult {
  roles_created: string[];
  docs_noticed: string[];   // doc IDs seen in schema (creation is optional — docs live in doc: keys)
  systems_noticed: string[]; // connector IDs seen in schema
  warnings: string[];
}

/**
 * Synchronise a workflow schema to the entity registry.
 *
 * @param def      The new (or created) workflow definition.
 * @param prevDef  The previous definition (for detecting removed entities).
 *                 Pass null on first creation.
 */
export async function syncSchemaToRegistry(
  def: WorkflowDefinition,
  prevDef?: WorkflowDefinition | null,
): Promise<SyncResult> {
  const result: SyncResult = {
    roles_created: [],
    docs_noticed: [],
    systems_noticed: [],
    warnings: [],
  };

  // ── 1. Collect roles from function elements ──────────────────────────────
  const schemaRoles = new Set<string>();
  for (const el of def.elements) {
    if (el.type === "function" && el.role) schemaRoles.add(el.role);
  }

  for (const roleId of schemaRoles) {
    try {
      const existing = await loadRole(roleId);
      if (!existing) {
        await createRole({
          role_id: roleId,
          name: roleId,
          description: "",
          assignees: [],
          strategy: "manual",
        });
        result.roles_created.push(roleId);
        console.log(`[schema-sync] Auto-created role "${roleId}" for workflow "${def.id}"`);
      }
      // Track which workflows reference this role (used for orphan detection)
      await redis.sadd(`konoha:role:${roleId}:workflows`, def.id).catch(() => {});
    } catch (e: any) {
      result.warnings.push(`Failed to sync role "${roleId}": ${e.message}`);
    }
  }

  // ── 2. Collect documents seen in schema ──────────────────────────────────
  const schemaDocs = new Set<string>();
  for (const el of def.elements) {
    if (el.documents) el.documents.forEach((d: string) => schemaDocs.add(d));
  }
  result.docs_noticed = [...schemaDocs];

  // ── 3. Collect information systems seen in schema ────────────────────────
  const schemaSystems = new Set<string>();
  for (const el of def.elements) {
    if (el.systems) {
      for (const s of el.systems) {
        if (s.connector) schemaSystems.add(s.connector);
      }
    }
  }
  result.systems_noticed = [...schemaSystems];

  // ── 4. Orphan detection (only when updating, not creating) ───────────────
  if (prevDef) {
    const prevRoles = new Set<string>();
    for (const el of prevDef.elements) {
      if (el.type === "function" && el.role) prevRoles.add(el.role);
    }

    const removedRoles = [...prevRoles].filter(r => !schemaRoles.has(r));
    for (const roleId of removedRoles) {
      // Remove this workflow from the role's workflow index
      await redis.srem(`konoha:role:${roleId}:workflows`, def.id).catch(() => {});

      // Check if any other workflow still references this role
      const remaining = await redis.scard(`konoha:role:${roleId}:workflows`).catch(() => 1);
      if (remaining === 0) {
        const msg = `Role "${roleId}" no longer used by any workflow — consider removing it via DELETE /roles/${roleId}`;
        result.warnings.push(msg);
        console.warn(`[schema-sync] ${msg}`);
      }
    }
  }

  return result;
}

/**
 * Cleanup role workflow index when a workflow is deleted.
 * Does NOT delete roles — only emits warnings for orphans.
 */
export async function cleanupWorkflowRefs(def: WorkflowDefinition): Promise<string[]> {
  const warnings: string[] = [];
  const schemaRoles = new Set<string>();
  for (const el of def.elements) {
    if (el.type === "function" && el.role) schemaRoles.add(el.role);
  }

  for (const roleId of schemaRoles) {
    await redis.srem(`konoha:role:${roleId}:workflows`, def.id).catch(() => {});
    const remaining = await redis.scard(`konoha:role:${roleId}:workflows`).catch(() => 1);
    if (remaining === 0) {
      const msg = `Role "${roleId}" is now orphaned (workflow "${def.id}" deleted)`;
      warnings.push(msg);
      console.warn(`[schema-sync] ${msg}`);
    }
  }

  return warnings;
}
