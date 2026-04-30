#!/usr/bin/env bun
/**
 * Audit and safely repair Workflow role registry hygiene.
 *
 * Default mode is dry-run. `--apply` only removes stale reverse-index entries:
 * `konoha:role:{roleId}:workflows` members where the workflow is missing or no
 * current function in that workflow references `roleId`.
 *
 * Role definitions with agent-like ids/names are reported for manual migration
 * because renaming roles changes process semantics and must not be automatic.
 */

import Redis from "ioredis";

type WorkflowElement = {
  id?: string;
  type?: string;
  role?: string;
};

type Workflow = {
  id?: string;
  elements?: WorkflowElement[];
};

type RoleDef = {
  role_id: string;
  name: string;
  description?: string;
  assignees?: string[];
  strategy?: string;
};

type StaleReverseRef = {
  role_id: string;
  workflow_id: string;
  reason: "workflow_missing" | "role_not_referenced";
};

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const json = args.has("--json");
const dryRun = args.has("--dry-run") || !apply;

if (args.has("--help") || args.has("-h")) {
  console.log(`usage: bun scripts/audit-role-registry.ts [--dry-run|--apply] [--json]

Audits role registry consistency.

--dry-run  Report issues only (default)
--apply    Remove stale role->workflow reverse-index entries only
--json     Emit machine-readable JSON summary`);
  process.exit(0);
}

const redis = new Redis({ host: "127.0.0.1", port: 6379, db: Number(process.env.REDIS_DB ?? "0") });

async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200) as [string, string[]];
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== "0");
  return keys.sort();
}

function parseRoleWorkflowIndexKey(key: string): string | null {
  const prefix = "konoha:role:";
  const suffix = ":workflows";
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return null;
  return key.slice(prefix.length, -suffix.length);
}

function isWorkflowUsingRole(workflow: Workflow, roleId: string): boolean {
  return (workflow.elements ?? []).some((el) => el.type === "function" && el.role === roleId);
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function intersects(values: string[] | undefined, candidates: Set<string>): boolean {
  return (values ?? []).some((value) => candidates.has(value));
}

try {
  const [roleIdsFromSortedSet, roleKeys, indexKeys, agentDefsRaw] = await Promise.all([
    redis.zrange("konoha:roles:all", 0, -1),
    scanKeys("role:*"),
    scanKeys("konoha:role:*:workflows"),
    redis.hgetall("konoha:agent-defs"),
  ]);

  const roleIdsFromKeys = roleKeys.map((key) => key.slice("role:".length));
  const roleIdsInSortedSet = new Set(roleIdsFromSortedSet);
  const roleIdsWithKeys = new Set(roleIdsFromKeys);

  const roleKeyMissingFromSortedSet = roleIdsFromKeys.filter((roleId) => !roleIdsInSortedSet.has(roleId));
  const sortedSetMissingRoleKey = roleIdsFromSortedSet.filter((roleId) => !roleIdsWithKeys.has(roleId));

  const agentIds = new Set<string>();
  const agentNames = new Set<string>();
  const agentAliases = new Set<string>();
  for (const raw of Object.values(agentDefsRaw)) {
    const agent = parseJson<{ id?: string; name?: string; display_alias?: string }>(raw);
    if (!agent) continue;
    if (agent.id) agentIds.add(agent.id);
    if (agent.name) agentNames.add(agent.name);
    if (agent.display_alias) agentAliases.add(agent.display_alias);
  }

  const roleDefs: RoleDef[] = [];
  for (const roleId of unique([...roleIdsFromKeys, ...roleIdsFromSortedSet])) {
    const role = parseJson<RoleDef>(await redis.get(`role:${roleId}`));
    if (role) roleDefs.push(role);
  }

  const agentLikeRoles = roleDefs
    .filter((role) => (
      agentIds.has(role.role_id)
      || agentAliases.has(role.role_id)
      || agentAliases.has(role.name)
      || intersects(role.assignees, agentAliases)
    ))
    .map((role) => ({
      role_id: role.role_id,
      name: role.name,
      assignees: role.assignees ?? [],
      reason: [
        agentIds.has(role.role_id) ? "role_id_is_agent_id" : "",
        agentAliases.has(role.role_id) ? "role_id_is_agent_alias" : "",
        agentAliases.has(role.name) ? "name_is_agent_alias" : "",
        intersects(role.assignees, agentAliases) ? "assignee_is_agent_alias" : "",
      ].filter(Boolean),
    }));

  const staleReverseRefs: StaleReverseRef[] = [];
  const indexWithoutRoleKey: string[] = [];
  const workflowCache = new Map<string, Workflow | null>();

  for (const key of indexKeys) {
    const roleId = parseRoleWorkflowIndexKey(key);
    if (!roleId) continue;
    if (!roleIdsWithKeys.has(roleId)) indexWithoutRoleKey.push(roleId);

    const workflowIds = await redis.smembers(key);
    for (const workflowId of workflowIds) {
      if (!workflowCache.has(workflowId)) {
        workflowCache.set(workflowId, parseJson<Workflow>(await redis.get(`workflow:${workflowId}`)));
      }
      const workflow = workflowCache.get(workflowId);
      if (!workflow) {
        staleReverseRefs.push({ role_id: roleId, workflow_id: workflowId, reason: "workflow_missing" });
      } else if (!isWorkflowUsingRole(workflow, roleId)) {
        staleReverseRefs.push({ role_id: roleId, workflow_id: workflowId, reason: "role_not_referenced" });
      }
    }
  }

  if (apply) {
    const pipeline = redis.multi();
    for (const item of staleReverseRefs) {
      pipeline.srem(`konoha:role:${item.role_id}:workflows`, item.workflow_id);
    }
    if (staleReverseRefs.length > 0) await pipeline.exec();
  }

  const summary = {
    mode: dryRun ? "dry-run" : "apply",
    roles_total: unique([...roleIdsFromKeys, ...roleIdsFromSortedSet]).length,
    role_key_missing_from_sorted_set: roleKeyMissingFromSortedSet,
    sorted_set_missing_role_key: sortedSetMissingRoleKey,
    reverse_indexes_total: indexKeys.length,
    reverse_indexes_without_role_key: unique(indexWithoutRoleKey),
    stale_reverse_refs: staleReverseRefs,
    stale_reverse_refs_removed: apply ? staleReverseRefs.length : 0,
    agent_like_roles: agentLikeRoles,
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`mode=${summary.mode}`);
    console.log(`roles_total=${summary.roles_total}`);
    console.log(`reverse_indexes_total=${summary.reverse_indexes_total}`);
    console.log(`stale_reverse_refs=${staleReverseRefs.length}`);
    console.log(`stale_reverse_refs_removed=${summary.stale_reverse_refs_removed}`);
    console.log(`role_key_missing_from_sorted_set=${roleKeyMissingFromSortedSet.length}`);
    console.log(`sorted_set_missing_role_key=${sortedSetMissingRoleKey.length}`);
    console.log(`reverse_indexes_without_role_key=${summary.reverse_indexes_without_role_key.length}`);
    console.log(`agent_like_roles=${agentLikeRoles.length}`);

    for (const item of staleReverseRefs.slice(0, 30)) {
      console.log(`stale_reverse_ref\t${item.reason}\trole=${item.role_id}\tworkflow=${item.workflow_id}`);
    }
    for (const item of agentLikeRoles.slice(0, 30)) {
      console.log(`agent_like_role\trole=${item.role_id}\tname=${item.name}\tassignees=${item.assignees.join(",")}\treason=${item.reason.join(",")}`);
    }
    if (dryRun) {
      console.log("No changes made. Re-run with --apply to remove stale reverse-index entries only.");
    }
  }
} finally {
  redis.disconnect();
}
