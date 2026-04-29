import { redis } from "./redis";
import { loadTrustedPeople } from "./people-directory";
import { ServiceError } from "./errors";

export const PEOPLE_CUSTOM_KEY = "people:custom";
export const PEOPLE_AVATARS_KEY = "people:avatars";

export type PersonRecord = {
  id: string;
  name: string;
  tg_id: number;
  position: string;
  tg_username?: string;
  email?: string;
  source?: "file" | "custom";
  bitrix24_id?: string;
  tracker_login?: string;
  yonote_id?: string;
  channel?: "telegram" | "email";
  capabilities?: string[];
  avatar_url?: string;
};

function personIdFromName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9@.-]/g, "");
}

function trustedPeople(): PersonRecord[] {
  return loadTrustedPeople()
    .filter((p): p is typeof p & { id: string } => typeof p.id === "string" && p.id.length > 0)
    .map(p => ({
      id: p.id,
      name: p.name,
      tg_id: p.tg_id ?? 0,
      position: p.position ?? "",
      tg_username: p.tg_username,
      source: "file",
      channel: p.channel === "telegram" || p.channel === "email" ? p.channel : undefined,
    }));
}

export async function listPeople(): Promise<PersonRecord[]> {
  const map = new Map<string, PersonRecord>(trustedPeople().map(p => [p.id, p]));
  try {
    const custom = await redis.hgetall(PEOPLE_CUSTOM_KEY);
    for (const val of Object.values(custom)) {
      const p: PersonRecord = JSON.parse(val);
      map.set(p.id, { ...p, source: "custom" });
    }
    const avatars = await redis.hgetall(PEOPLE_AVATARS_KEY);
    for (const [id, avatar_url] of Object.entries(avatars)) {
      const existing = map.get(id);
      if (existing && !existing.avatar_url) map.set(id, { ...existing, avatar_url });
    }
  } catch {
    // Redis outage should not hide file-backed trusted users.
  }
  return [...map.values()];
}

export async function getPerson(id: string): Promise<PersonRecord | null> {
  const rawCustom = await redis.hget(PEOPLE_CUSTOM_KEY, id).catch(() => null);
  if (rawCustom) return { ...JSON.parse(rawCustom), source: "custom" };
  return trustedPeople().find(p => p.id === id) ?? null;
}

export async function upsertCustomPerson(body: Partial<PersonRecord>): Promise<PersonRecord> {
  if (!body.name?.trim()) throw new ServiceError(400, "name required");
  const id = body.id?.trim() || personIdFromName(body.name);
  if (!id) throw new ServiceError(400, "id required");
  if (trustedPeople().some(p => p.id === id)) {
    throw new ServiceError(409, "Cannot override file-based users");
  }
  const record: PersonRecord = {
    id,
    name: body.name.trim(),
    tg_id: body.tg_id ?? 0,
    position: body.position?.trim() || "",
    tg_username: body.tg_username?.trim().replace(/^@/, "") || undefined,
    email: body.email?.trim() || undefined,
    source: "custom",
    bitrix24_id: body.bitrix24_id?.trim() || undefined,
    tracker_login: body.tracker_login?.trim() || undefined,
    yonote_id: body.yonote_id?.trim() || undefined,
    channel: body.channel === "telegram" || body.channel === "email" ? body.channel : undefined,
    capabilities: Array.isArray(body.capabilities) ? body.capabilities : undefined,
    avatar_url: body.avatar_url?.trim() || undefined,
  };
  await redis.hset(PEOPLE_CUSTOM_KEY, id, JSON.stringify(record));
  return record;
}

export async function deleteCustomPerson(id: string): Promise<{ ok: true }> {
  if (trustedPeople().some(p => p.id === id)) {
    throw new ServiceError(403, "Cannot delete file-based users");
  }
  const deleted = await redis.hdel(PEOPLE_CUSTOM_KEY, id);
  if (!deleted) throw new ServiceError(404, "Not found");
  return { ok: true };
}

export async function savePersonAvatar(id: string, avatar_url: string): Promise<{ file_based: boolean }> {
  const rawCustom = await redis.hget(PEOPLE_CUSTOM_KEY, id).catch(() => null);
  if (rawCustom) {
    const person = JSON.parse(rawCustom) as PersonRecord;
    await redis.hset(PEOPLE_CUSTOM_KEY, id, JSON.stringify({ ...person, avatar_url }));
    return { file_based: false };
  }
  const trusted = trustedPeople().find(p => p.id === id);
  if (!trusted) throw new ServiceError(404, "Person not found");
  await redis.hset(PEOPLE_AVATARS_KEY, id, avatar_url);
  return { file_based: true };
}
