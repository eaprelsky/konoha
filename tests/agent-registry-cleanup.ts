import { createTestRedis } from "./redis-test-utils";
import { createTestPostgres } from "./pg-test-utils";

export interface GeneratedAgentCleanupScope {
  idSuffix?: string;
}

function isGeneratedAgentId(id: string, scope?: GeneratedAgentCleanupScope): boolean {
  if (scope?.idSuffix) return id.endsWith(`-${scope.idSuffix}`);
  return id.startsWith("rtest-") || /^test(-[a-z0-9-]+)?-t[0-9]+$/.test(id);
}

export async function cleanupGeneratedTestAgents(scope?: GeneratedAgentCleanupScope): Promise<void> {
  const redis = createTestRedis();
  const sql = createTestPostgres({
    max: 2,
    idle_timeout: 10,
    connect_timeout: 5,
    onnotice: () => {},
  });

  try {
    if (scope?.idSuffix) {
      await sql`DELETE FROM konoha_agents WHERE id LIKE ${`%-${scope.idSuffix}`}`;
    } else {
      await sql`
        DELETE FROM konoha_agents
        WHERE id LIKE 'rtest-%'
           OR id ~ '^test(-[a-z0-9-]+)?-t[0-9]+$'
      `;
    }

    const streamKeys = scope?.idSuffix
      ? await redis.keys(`konoha:agent:*-${scope.idSuffix}`)
      : [
          ...(await redis.keys("konoha:agent:rtest-*")),
          ...(await redis.keys("konoha:agent:test*-t*")),
        ];
    if (streamKeys.length) await redis.del(...new Set(streamKeys));

    const tokenMap = await redis.hgetall("konoha:tokens");
    for (const [tok, agentId] of Object.entries(tokenMap ?? {})) {
      if (isGeneratedAgentId(agentId, scope)) await redis.hdel("konoha:tokens", tok);
    }
  } finally {
    await sql.end({ timeout: 5 });
    redis.disconnect();
  }
}
