/**
 * roles.ts — Role directory CRUD.
 * Extracted from runtime.ts (issue #338).
 */
import { redis } from "../redis";
import { silentCatch } from "../logger";
import { pgUpsertRole, pgDeleteRole, pgGetRole, pgListRoles as pgListRolesRaw } from "../storage/pg";

const PG_READ = process.env.PG_READ === "true";

const ROLE_KEY_PREFIX = "role:";
const ROLES_IDX_ALL = "konoha:roles:all";

export type AssignmentStrategy = "round-robin" | "load-balancing" | "broadcast" | "manual";

export interface RoleDef {
  role_id: string;
  name: string;
  description?: string;
  assignees: string[];
  strategy: AssignmentStrategy;
  required_capabilities?: string[];
  created_at: string;
  updated_at: string;
}

function isoStr(v: unknown): string {
  if (!v) return new Date().toISOString();
  return v instanceof Date ? v.toISOString() : String(v);
}

function pgRowToRole(row: Record<string, unknown>): RoleDef {
  return {
    role_id: String(row.id),
    name: String(row.name ?? ''),
    description: row.description ? String(row.description) : undefined,
    assignees: Array.isArray(row.assignees) ? row.assignees as string[] : [],
    strategy: (row.strategy ?? 'manual') as AssignmentStrategy,
    created_at: isoStr(row.created_at),
    updated_at: isoStr(row.updated_at),
  };
}

async function saveRole(r: RoleDef): Promise<void> {
  await redis.set(ROLE_KEY_PREFIX + r.role_id, JSON.stringify(r));
  await redis.zadd(ROLES_IDX_ALL, new Date(r.created_at).getTime(), r.role_id);
  pgUpsertRole({ id: r.role_id, name: r.name, description: r.description, assignees: r.assignees || [], strategy: r.strategy, updated_at: new Date().toISOString() });
}

export async function loadRole(role_id: string): Promise<RoleDef | null> {
  if (PG_READ) {
    const row = await pgGetRole(role_id);
    return row ? pgRowToRole(row) : null;
  }
  const raw = await redis.get(ROLE_KEY_PREFIX + role_id);
  return raw ? JSON.parse(raw) : null;
}

export async function createRole(params: Omit<RoleDef, "created_at" | "updated_at">): Promise<RoleDef> {
  const now = new Date().toISOString();
  const r: RoleDef = { ...params, created_at: now, updated_at: now };
  await saveRole(r);
  return r;
}

export async function listRoles(): Promise<RoleDef[]> {
  if (PG_READ) {
    const rows = await pgListRolesRaw();
    return rows.map(pgRowToRole);
  }
  const ids = await redis.zrange(ROLES_IDX_ALL, 0, -1);
  const roles = await Promise.all(ids.map(id => loadRole(id)));
  return roles.filter((r): r is RoleDef => r !== null);
}

export async function updateRole(role_id: string, patch: Partial<Pick<RoleDef, "name" | "description" | "assignees" | "strategy" | "required_capabilities">>): Promise<RoleDef> {
  const r = await loadRole(role_id);
  if (!r) throw new Error(`Role "${role_id}" not found`);
  if (patch.name !== undefined)                   r.name = patch.name;
  if (patch.description !== undefined)            r.description = patch.description;
  if (patch.assignees !== undefined)              r.assignees = patch.assignees;
  if (patch.strategy !== undefined)               r.strategy = patch.strategy;
  if (patch.required_capabilities !== undefined)  r.required_capabilities = patch.required_capabilities;
  r.updated_at = new Date().toISOString();
  await saveRole(r);
  if (patch.assignees !== undefined) {
    redis.xadd("konoha:agent-reload", "*", "type", "role.assigned", "role_id", role_id, "timestamp", new Date().toISOString()).catch(silentCatch("role reload notification"));
  }
  return r;
}

export async function deleteRole(role_id: string): Promise<void> {
  await redis.del(ROLE_KEY_PREFIX + role_id);
  await redis.zrem(ROLES_IDX_ALL, role_id);
  pgDeleteRole(role_id);
}
