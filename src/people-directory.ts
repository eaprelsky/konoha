import { existsSync, readFileSync } from "fs";
import { config } from "./config";
import { redis } from "./redis";

const PEOPLE_CUSTOM_KEY = "people:custom";

export type PersonRecord = {
  id?: string;
  name: string;
  tg_id?: number;
  tg_username?: string;
  position?: string;
  channel?: string;
};

export function loadTrustedPeople(): PersonRecord[] {
  try {
    if (!existsSync(config.paths.trustedUsers)) return [];
    const raw = readFileSync(config.paths.trustedUsers, "utf-8");
    const data = JSON.parse(raw) as {
      owner?: { name: string; telegram_id: number; username?: string };
      trusted?: { name: string; telegram_id: number; username?: string | null; position?: string }[];
    };
    const toId = (name: string, username?: string | null) =>
      username ? `@${username}` : name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const people: PersonRecord[] = [];
    if (data.owner) {
      people.push({
        id: toId(data.owner.name, data.owner.username),
        name: data.owner.name,
        tg_id: data.owner.telegram_id,
        tg_username: data.owner.username || undefined,
        position: "Owner",
      });
    }
    for (const person of data.trusted || []) {
      people.push({
        id: toId(person.name, person.username),
        name: person.name,
        tg_id: person.telegram_id,
        tg_username: person.username || undefined,
        position: person.position || "",
      });
    }
    return people;
  } catch {
    return [];
  }
}

async function listCustomPeople(): Promise<PersonRecord[]> {
  try {
    const custom = await redis.hgetall(PEOPLE_CUSTOM_KEY);
    return Object.values(custom).map((value) => JSON.parse(value) as PersonRecord);
  } catch {
    return [];
  }
}

export async function findPersonByRole(role: string): Promise<PersonRecord | null> {
  for (const person of await listCustomPeople()) {
    if (person.name === role || person.position === role) return person;
  }
  for (const person of loadTrustedPeople()) {
    if (person.name === role || person.position === role) return person;
  }
  return null;
}

export async function findPersonById(id: string): Promise<PersonRecord | null> {
  const normalized = id.replace(/^@/, "");
  for (const person of await listCustomPeople()) {
    if (person.id === id || person.name === id || person.tg_username === normalized) return person;
  }
  for (const person of loadTrustedPeople()) {
    if (person.id === id || person.name === id || person.tg_username === normalized) return person;
  }
  return null;
}
