/**
 * System agent — handles automated function execution:
 * - Timer/wait functions (Подождать N минут)
 * - Document generation via Haiku
 * - Shell script execution (bitrix-monitor, etc.)
 * - General auto-complete for system-role functions
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "./config";
import { loadInstructionText } from "./document-instructions";
import { generateText } from "./llm";
import { createLogger } from "./logger";
import { createReminder, completeWorkItem } from "./runtime";

const execFileAsync = promisify(execFile);
const log = createLogger("system-agent");

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

/** Generate document text via Haiku from instruction prompt. */
async function generateDocContent(prompt: string, label: string): Promise<string> {
  return generateText({
    model: "claude-haiku-4-5-20251001",
    maxTokens: 2000,
    messages: [{
      role: "user",
      content: `Ты — генератор документов. Создай документ по следующей инструкции.\n\nЗадача: ${label}\n\nИнструкция:\n${prompt}\n\nНапиши готовый текст документа. Без пояснений.`,
    }],
  });
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
      log.info("timer set", { wait_minutes: waitMinutes, scheduled_at: scheduledAt, work_item_id });
    } catch (e: any) {
      log.error("failed to create timer reminder", { work_item_id, error: e.message });
      await completeWorkItem(work_item_id, { system: "timer-error", error: e.message }).catch(() => {});
    }
    return; // work item will be auto-completed by scheduler
  }

  // 2. Document generation: label matches generation pattern AND docs attached
  const isGenTask = /генер|создат[ьь].*?(документ|текст|отчёт|report|doc)/i.test(label);
  if (isGenTask) {
    const instruction = await loadInstructionText(docIds);
    const prompt = instruction || label;
    try {
      const content = await generateDocContent(prompt, label);
      const slug = label.slice(0, 40).replace(/[^a-zA-Zа-яА-Я0-9]/g, "_").replace(/_+/g, "_");
      const filename = `${slug}_${Date.now()}.txt`;
      writeFileSync(join(config.paths.workspaceDir, filename), content, "utf-8");
      log.info("generated document", { filename, work_item_id });
      await completeWorkItem(work_item_id, { generated_file: filename, content_preview: content.slice(0, 200) });
    } catch (e: any) {
      log.error("doc generation failed", { work_item_id, error: e.message });
      await completeWorkItem(work_item_id, { system: "gen-error", error: e.message }).catch(() => {});
    }
    return;
  }

  // 3. Bitrix monitor: run bitrix-poller.py monitor
  if (/bitrix.*monitor|run.*bitrix.*monitor/i.test(label)) {
    log.info("running bitrix monitor", { work_item_id });
    try {
      const { stdout, stderr } = await execFileAsync(
        "python3",
        ["/home/ubuntu/konoha/scripts/bitrix-poller.py", "monitor"],
        { timeout: 120_000 },
      );
      if (stdout) log.info("bitrix monitor stdout", { work_item_id, stdout: stdout.slice(0, 500) });
      if (stderr) log.warn("bitrix monitor stderr", { work_item_id, stderr: stderr.slice(0, 200) });
      await completeWorkItem(work_item_id, { system: "bitrix-monitor", exit_code: 0 });
    } catch (e: any) {
      log.error("bitrix monitor failed", { work_item_id, error: e.message });
      await completeWorkItem(work_item_id, { system: "bitrix-monitor-error", error: e.message }).catch(() => {});
    }
    return;
  }

  // 4. Fallback: auto-complete (system acknowledges the step)
  try {
    await completeWorkItem(work_item_id, { system: "auto-executed", label });
    log.info("auto-completed work item", { work_item_id, label });
  } catch (e: any) {
    log.error("auto-complete failed", { work_item_id, error: e.message });
  }
}
