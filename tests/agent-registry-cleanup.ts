import Redis from "ioredis";
import postgres from "postgres";
import { getDatabaseUrl } from "../src/storage/database-url";

export async function cleanupGeneratedTestAgents(): Promise<void> {
  const redis = new Redis({ host: "127.0.0.1", port: 6379, db: parseInt(process.env.REDIS_DB ?? "0", 10) });
  const sql = postgres(getDatabaseUrl(), {
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
