export interface PgVerifyCheckResult {
  entity: string;
  redisCount: number;
  pgCount: number;
  onlyInRedis: string[];
  onlyInPg: string[];
  ok: boolean;
  redisLabel?: string;
  pgLabel?: string;
  onlyInRedisLabel?: string;
  onlyInPgLabel?: string;
  onlyInPgDisposition?: string;
  onlyInRedisIsWarning?: boolean;
  ignoreOnlyInPgBloat?: boolean;
  strictOnlyInPgIsError?: boolean;
}

function sortedUnique(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

export function compareAgentPresence(redisRegistryIds: string[], pgPresenceIds: string[]): PgVerifyCheckResult {
  const redisIds = sortedUnique(redisRegistryIds);
  const pgIds = sortedUnique(pgPresenceIds);
  const redisSet = new Set(redisIds);
  const pgSet = new Set(pgIds);

  return {
    entity: "agent_presence",
    redisCount: redisIds.length,
    pgCount: pgIds.length,
    redisLabel: "Redis legacy registry",
    pgLabel: "PG presence",
    onlyInRedis: redisIds.filter(id => !pgSet.has(id)),
    onlyInPg: pgIds.filter(id => !redisSet.has(id)),
    onlyInRedisLabel: "Only in Redis legacy registry [stale compatibility, not a cutover blocker]",
    onlyInPgLabel: "Only in PG presence",
    onlyInPgDisposition: "canonical, OK",
    onlyInRedisIsWarning: true,
    ignoreOnlyInPgBloat: true,
    strictOnlyInPgIsError: false,
    ok: true,
  };
}

export function compareManagedAgentDefinitionStores(input: {
  legacyIds: string[];
  templateIds: string[];
  runtimeConfigIds: string[];
}): PgVerifyCheckResult {
  const legacyIds = sortedUnique(input.legacyIds);
  const templateIds = sortedUnique(input.templateIds);
  const runtimeConfigIds = sortedUnique(input.runtimeConfigIds);
  const allIds = sortedUnique([...legacyIds, ...templateIds, ...runtimeConfigIds]);
  const templateSet = new Set(templateIds);
  const runtimeConfigSet = new Set(runtimeConfigIds);

  const incomplete = allIds.flatMap((id) => {
    const missing: string[] = [];
    if (!templateSet.has(id)) missing.push("template");
    if (!runtimeConfigSet.has(id)) missing.push("runtime_config");
    return missing.length > 0 ? [`${id}:missing_${missing.join("+")}`] : [];
  });
  const completeCount = allIds.length - incomplete.length;

  return {
    entity: "managed_agent_definitions",
    redisCount: allIds.length,
    pgCount: completeCount,
    redisLabel: "AgentDef ids",
    pgLabel: "complete template/runtime projections",
    onlyInRedis: incomplete,
    onlyInPg: [],
    onlyInRedisLabel: "Incomplete managed AgentDef projections",
    ok: incomplete.length === 0,
  };
}
