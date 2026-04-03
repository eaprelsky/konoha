/**
 * System agent — handles automated function execution:
 * - Timer/wait functions (Подождать N минут)
 * - Document generation via Haiku
 * - General auto-complete for system-role functions
 */
import { writeFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { redis } from "./redis";
import { createReminder, completeWorkItem } from "./runtime";

const WORKSPACE_DIR = "/opt/shared/workspace";
const DOC_KEY_PREFIX = "doc:";

/** Role names that map to the system agent. */
const SYSTEM_ROLES = new Set(["Система", "System", "system", "система", "СИСТЕМА"]);

export function isSystemRole(role: string): boolean {
  return SYSTEM_ROLES.has(role);
}

/** Parse "Подождать N минут/часов/секунд" → duration in minutes, or null. */
function parseWaitMinutes(label: string): number | null {
  const m = label.match(/подождать\s+(\d+(?:[.,]\d+)?)\s*(мин(?:ут)?|час(?:ов?)?|сек(?:унд)?)/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  const unit = m[2].toLowerCase();
  if (unit.startsWith("сек")) return n / 60;
  if (unit.startsWith("час")) return n * 60;
  return n; // минуты
}

/** Load instruction text from document IDs attached to the element. */
async function loadDocTexts(docIds: string[]): Promise<string> {
  if (!docIds.length) return "";
  const parts: string[] = [];
  for (const id of docIds) {
    try {
      const raw = await redis.get(DOC_KEY_PREFIX + id);
      if (raw) {
        const doc = JSON.parse(raw);
        if (doc.content) parts.push(`[${doc.name || id}]\n${doc.content}`);
      }
    } catch { /* skip */ }
  }
  return parts.join("\n\n");
}

/** Generate document text via Haiku from instruction prompt. */
async function generateDocContent(prompt: string, label: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: `Ты — генератор документов. Создай документ по следующей инструкции.\n\nЗадача: ${label}\n\nИнструкция:\n${prompt}\n\nНапиши готовый текст документа. Без пояснений.`,
    }],
  });
  return (msg.content[0] as any).text.trim();
}

export interface SystemExecParams {
  label: string;
  work_item_id: string;
  case_id: string;
  process_id: string;
  element_id: string;
  docIds: string[];
}

/**
 * Execute a system-role function. Called from dispatcher.
 * All errors are caught internally — never throws.
 */
export async function executeSystemFunction(params: SystemExecParams): Promise<void> {
  const { label, work_item_id, case_id, process_id, element_id, docIds } = params;

  // 1. Timer: "Подождать N минут"
  const waitMinutes = parseWaitMinutes(label);
  if (waitMinutes !== null) {
    const scheduledAt = new Date(Date.now() + waitMinutes * 60 * 1000).toISOString();
    try {
      await createReminder({
        type: "process-bound",
        recipient: "system",
        message: `Таймер: ${label} (work_item=${work_item_id})`,
        scheduled_at: scheduledAt,
        channel: "gui",
        case_id,
        process_id,
        element_id,
        work_item_id,
      });
      console.log(`[system-agent] timer set: ${waitMinutes} min → ${scheduledAt} for work_item ${work_item_id}`);
    } catch (e: any) {
      console.error(`[system-agent] failed to create timer reminder:`, e.message);
      await completeWorkItem(work_item_id, { system: "timer-error", error: e.message }).catch(() => {});
    }
    return; // work item will be auto-completed by scheduler
  }

  // 2. Document generation: label matches generation pattern AND docs attached
  const isGenTask = /генер|создат[ьь].*?(документ|текст|отчёт|report|doc)/i.test(label);
  if (isGenTask) {
    const instruction = await loadDocTexts(docIds);
    const prompt = instruction || label;
    try {
      const content = await generateDocContent(prompt, label);
      const slug = label.slice(0, 40).replace(/[^a-zA-Zа-яА-Я0-9]/g, "_").replace(/_+/g, "_");
      const filename = `${slug}_${Date.now()}.txt`;
      writeFileSync(join(WORKSPACE_DIR, filename), content, "utf-8");
      console.log(`[system-agent] generated doc: ${filename}`);
      await completeWorkItem(work_item_id, { generated_file: filename, content_preview: content.slice(0, 200) });
    } catch (e: any) {
      console.error(`[system-agent] doc generation failed:`, e.message);
      await completeWorkItem(work_item_id, { system: "gen-error", error: e.message }).catch(() => {});
    }
    return;
  }

  // 3. Fallback: auto-complete (system acknowledges the step)
  try {
    await completeWorkItem(work_item_id, { system: "auto-executed", label });
    console.log(`[system-agent] auto-completed work_item ${work_item_id} (label: "${label}")`);
  } catch (e: any) {
    console.error(`[system-agent] auto-complete failed for ${work_item_id}:`, e.message);
  }
}
