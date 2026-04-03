/**
 * Task dispatcher: when a case reaches a Function node, dispatch the work item
 * to the appropriate agent (via Konoha bus) or person (via Telegram).
 */
import { redis } from "./redis";
import { listAgents, sendMessage } from "./redis";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, existsSync } from "fs";

const execFileAsync = promisify(execFile);

const DOC_KEY_PREFIX = "doc:";
const PEOPLE_CUSTOM_KEY = "people:custom";
const TRUSTED_PATH = "/opt/shared/.trusted-users.json";
const TG_SEND_SCRIPT = "/home/ubuntu/tg-send.py";

/** Load instruction text from document IDs. Falls back to the function label. */
async function loadInstructionText(docIds: string[], label: string): Promise<string> {
  if (!docIds.length) return label;
  const texts: string[] = [];
  for (const id of docIds) {
    try {
      const raw = await redis.get(DOC_KEY_PREFIX + id);
      if (raw) {
        const doc = JSON.parse(raw);
        if (doc.content) texts.push(`[${doc.name || id}]\n${doc.content}`);
      }
    } catch { /* skip missing docs */ }
  }
  return texts.length ? texts.join("\n\n") : label;
}

type PersonRecord = {
  name: string; tg_id?: number; tg_username?: string;
  position?: string; channel?: string;
};

/** Look up a person by role name (matches name or position). */
async function findPersonByRole(role: string): Promise<PersonRecord | null> {
  // Redis custom people
  try {
    const custom = await redis.hgetall(PEOPLE_CUSTOM_KEY);
    for (const val of Object.values(custom)) {
      const p: PersonRecord = JSON.parse(val);
      if (p.name === role || p.position === role) return p;
    }
  } catch { /* redis unavailable */ }

  // trusted-users.json
  try {
    if (existsSync(TRUSTED_PATH)) {
      const data = JSON.parse(readFileSync(TRUSTED_PATH, "utf-8")) as {
        owner?: { name: string; telegram_id: number; username?: string; position?: string };
        trusted?: { name: string; telegram_id: number; username?: string; position?: string }[];
      };
      const all = [data.owner, ...(data.trusted || [])].filter(Boolean) as NonNullable<typeof data.owner>[];
      for (const u of all) {
        if (u.name === role || u.position === role) {
          return { name: u.name, tg_id: u.telegram_id, tg_username: u.username || undefined };
        }
      }
    }
  } catch { /* file unavailable */ }

  return null;
}

export interface DispatchParams {
  role: string;
  label: string;
  work_item_id: string;
  case_id: string;
  process_id: string;
  docIds: string[];
}

/** Dispatch a work item to an agent or person based on role. Fire-and-forget safe. */
export async function dispatchWorkItem(params: DispatchParams): Promise<void> {
  const { role, label, work_item_id, case_id, process_id, docIds } = params;

  const instruction = await loadInstructionText(docIds, label);
  const hasExtra = instruction !== label;

  // 1. Check if role matches a registered Konoha agent
  const agents = await listAgents(true); // online only
  const agent = agents.find(a => a.id === role || a.name === role);
  if (agent) {
    const text = [
      `[Задача от runtime] Процесс: ${process_id} | Кейс: ${case_id}`,
      `Функция: ${label}`,
      hasExtra ? `\nИнструкция:\n${instruction}` : "",
      `\nwork_item_id: ${work_item_id}`,
    ].filter(Boolean).join("\n");

    await sendMessage({ from: "runtime", to: agent.id, type: "task", text });
    console.log(`[dispatcher] sent task to agent "${agent.id}" for work_item ${work_item_id}`);
    return;
  }

  // 2. Check if role matches a person
  const person = await findPersonByRole(role);
  if (person?.tg_id) {
    const lines = [
      `Новая задача: ${label}`,
      `Процесс: ${process_id}`,
      `Кейс: ${case_id}`,
      `ID: ${work_item_id}`,
    ];
    if (hasExtra) lines.push(`\n${instruction}`);
    const tgText = lines.join("\n");

    await execFileAsync("python3", [TG_SEND_SCRIPT, String(person.tg_id), tgText])
      .then(() => console.log(`[dispatcher] telegram sent to tg_id=${person.tg_id} for work_item ${work_item_id}`))
      .catch(e => console.error(`[dispatcher] telegram send failed for work_item ${work_item_id}:`, e.message));
    return;
  }

  // 3. No match — work item stays as manual (visible in Work Items UI)
  console.log(`[dispatcher] no dispatch target for role "${role}" — work_item ${work_item_id} stays manual`);
}
