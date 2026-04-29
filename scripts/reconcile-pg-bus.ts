#!/usr/bin/env bun
/**
 * Reconcile Konoha bus Redis state into PostgreSQL shadow tables.
 *
 * This is intentionally separate from agent registration:
 * - agent snapshots are upserted without rotating tokens;
 * - message history is copied from per-agent Redis streams only;
 * - inserts are idempotent by (recipient, stream_id).
 */

import Redis from "ioredis";
import type { Agent, Attachment, Message } from "../src/redis";
import { pgCloseBus, pgStoreMessage, pgUpsertAgentSnapshot } from "../src/storage/pg-bus";

const DEFAULT_VILLAGE = "comind.konoha";
const DRY_RUN = process.argv.includes("--dry-run");
const redis = new Redis({ host: "127.0.0.1", port: 6379, db: Number(process.env.REDIS_DB ?? "0") });

type RedisStreamEntry = [string, string[]];

interface ReconcileStats {
  scanned: number;
  inserted: number;
  skipped: number;
  failed: number;
}

async function scanKeys(match: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", match, "COUNT", 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");

  return keys.sort();
}

async function scanStreamKeys(match: string): Promise<string[]> {
  const keys = await scanKeys(match);
  const streamKeys: string[] = [];

  for (const key of keys) {
    if ((await redis.type(key)) === "stream") {
      streamKeys.push(key);
    }
  }

  return streamKeys;
}

function parseJsonArray<T>(raw: string | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function fieldsToObject(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1] ?? "";
  }
  return obj;
}

function agentFromRegistry(raw: string): Agent | null {
  const parsed = JSON.parse(raw) as Partial<Agent>;
  if (!parsed.id) return null;
  const villageId = parsed.village_id ?? DEFAULT_VILLAGE;
  return {
    id: parsed.id,
    name: parsed.name ?? parsed.id,
    capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
    roles: Array.isArray(parsed.roles) ? parsed.roles : [],
    model: parsed.model,
    status: parsed.status ?? "offline",
    lastHeartbeat: Number(parsed.lastHeartbeat ?? Date.now()),
    eventSubscriptions: Array.isArray(parsed.eventSubscriptions) ? parsed.eventSubscriptions : [],
    village_id: villageId,
    address: parsed.address ?? `${parsed.id}@${villageId}`,
  };
}

function messageFromStreamEntry(stream: string, entry: RedisStreamEntry): Message {
  const [id, fields] = entry;
  const obj = fieldsToObject(fields);
  const recipient = stream.slice("konoha:agent:".length);
  const attachments = parseJsonArray<Attachment>(obj.attachments);

  return {
    id,
    from: obj.from || "unknown",
    to: recipient,
    type: (obj.type || "message") as Message["type"],
    text: obj.text || "",
    channel: obj.channel || undefined,
    replyTo: obj.replyTo || undefined,
    timestamp: obj.timestamp || new Date().toISOString(),
    attachments: attachments.length > 0 ? attachments : undefined,
    village_id: obj.village_id || DEFAULT_VILLAGE,
  };
}

async function reconcileAgents(): Promise<ReconcileStats> {
  const registry = await redis.hgetall("konoha:registry");
  const stats: ReconcileStats = { scanned: 0, inserted: 0, skipped: 0, failed: 0 };

  for (const raw of Object.values(registry)) {
    stats.scanned++;
    try {
      const agent = agentFromRegistry(raw);
      if (!agent) {
        stats.skipped++;
        continue;
      }
      if (!DRY_RUN) await pgUpsertAgentSnapshot(agent);
      stats.inserted++;
    } catch (error) {
      stats.failed++;
      console.error(`  agent failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return stats;
}

async function reconcileMessages(): Promise<ReconcileStats> {
  const streams = await scanStreamKeys("konoha:agent:*");
  const stats: ReconcileStats = { scanned: 0, inserted: 0, skipped: 0, failed: 0 };

  for (const stream of streams) {
    try {
      const entries = await redis.xrange(stream, "-", "+") as RedisStreamEntry[];
      for (const entry of entries) {
        stats.scanned++;
        try {
          const message = messageFromStreamEntry(stream, entry);
          const inserted = DRY_RUN ? true : await pgStoreMessage(message);
          if (inserted) stats.inserted++;
          else stats.skipped++;
        } catch (error) {
          stats.failed++;
          console.error(`  message failed in ${stream}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      stats.failed++;
      console.error(`  stream failed ${stream}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return stats;
}

function printStats(entity: string, stats: ReconcileStats): void {
  console.log(
    `${entity}: scanned=${stats.scanned} ${DRY_RUN ? "would_insert" : "inserted"}=${stats.inserted} skipped=${stats.skipped} failed=${stats.failed}`,
  );
}

async function main(): Promise<void> {
  console.log(`=== Konoha PG Bus Reconcile ${DRY_RUN ? "(DRY RUN)" : ""} ===`);
  const agents = await reconcileAgents();
  const messages = await reconcileMessages();

  printStats("agents", agents);
  printStats("messages", messages);

  if (agents.failed > 0 || messages.failed > 0) {
    process.exit(1);
  }
}

main()
  .then(async () => {
    redis.disconnect();
    await pgCloseBus();
  })
  .catch(async (error) => {
    console.error("Fatal:", error instanceof Error ? error.message : String(error));
    redis.disconnect();
    await pgCloseBus();
    process.exit(1);
  });
