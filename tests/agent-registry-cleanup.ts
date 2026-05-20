import { createTestRedis } from "./redis-test-utils";
import { createTestPostgres } from "./pg-test-utils";

export async function cleanupGeneratedTestAgents(): Promise<void> {
  const redis = createTestRedis();
  const sql = createTestPostgres({
    max: 2,
    idle_timeout: 10,
    connect_timeout: 5,
    onnotice: () => {},
  });

  try {
    await sql`
      DELETE FROM konoha_agents
      WHERE id LIKE 'rtest-%'
         OR id ~ '^test(-[a-z0-9-]+)?-t[0-9]+$'
    `;

    const streamKeys = [
      ...(await redis.keys("konoha:agent:rtest-*")),
      ...(await redis.keys("konoha:agent:test*-t*")),
    ];
    if (streamKeys.length) await redis.del(...new Set(streamKeys));
  } finally {
    await sql.end({ timeout: 5 });
    redis.disconnect();
  }
}
