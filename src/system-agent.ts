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
import { createReminder } from "./runtime/reminders";
import { completeWorkItem, updateWorkItem } from "./runtime/work-items";
import { createTimerWait } from "./runtime/event-waits";
import type { SystemBinding } from "./workflow-loader";

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
  systems?: SystemBinding[];
  payload?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function actionArgsFor(operation: string, payload: Record<string, unknown> = {}): Record<string, unknown> | null {
  const actionArgs = payload.action_args;
  if (isRecord(actionArgs)) {
    const scoped = actionArgs[operation];
    if (isRecord(scoped)) return scoped;
  }
  return null;
}

async function failSystemWorkItem(work_item_id: string, output: Record<string, unknown>): Promise<void> {
  await updateWorkItem(work_item_id, { status: "error", output }).catch(e =>
    log.error("failed to mark system work item error", { work_item_id, error: e?.message }),
  );
}

async function executeActionSpineBindings(params: SystemExecParams, systems: SystemBinding[]): Promise<boolean> {
  const actionBindings = systems.filter(binding => binding.connector === "action_spine" && binding.operation);
  if (actionBindings.length === 0) return false;

  const receipts: Array<{ action: string; status: number; data: unknown }> = [];
  const [{ executeAction }, { classifyAction }] = await Promise.all([
    import("./act-envelope"),
    import("./action-registry"),
  ]);
  for (const binding of actionBindings) {
    const operation = binding.operation!;
    const args = actionArgsFor(operation, params.payload);
    if (!args) {
      const output = {
        system: "action_spine-error",
        error: `missing action_args for ${operation}`,
        action: operation,
        work_item_id: params.work_item_id,
      };
      log.error("action_spine args missing", { work_item_id: params.work_item_id, operation });
      await failSystemWorkItem(params.work_item_id, output);
      return true;
    }

    const result = await executeAction({
      action: operation,
      category: classifyAction(operation),
      args,
      meta: {
        session_id: `workflow:${params.work_item_id}`,
        agent_chain: "workflow:system-agent",
      },
    }, {
      session_id: `workflow:${params.work_item_id}`,
      agent_chain: "workflow:system-agent",
      skipAutonomy: true,
    });

    const status = result.status ?? (result.ok ? 200 : 500);
    receipts.push({ action: operation, status, data: result.ok ? result.data : { error: result.error } });
    if (!result.ok || status < 200 || status >= 300) {
      const output = {
        system: "action_spine-error",
        action: operation,
        status,
        data: result.ok ? result.data : { error: result.error },
        receipts,
      };
      log.error("action_spine action failed", { work_item_id: params.work_item_id, operation, status });
      await failSystemWorkItem(params.work_item_id, output);
      return true;
    }
  }

  await completeWorkItem(params.work_item_id, { system: "action_spine", receipts });
  log.info("action_spine completed work item", { work_item_id: params.work_item_id, actions: receipts.map(r => r.action) });
  return true;
}

/**
 * Execute a system-role function. Called from dispatcher.
 * All errors are caught internally — never throws.
 */
export async function executeSystemFunction(params: SystemExecParams): Promise<void> {
  const { label, work_item_id, case_id, process_id, element_id, docIds } = params;

  try {
    const handled = await executeActionSpineBindings(params, params.systems ?? []);
    if (handled) return;
  } catch (e: any) {
    log.error("action_spine execution crashed", { work_item_id, error: e.message });
    await failSystemWorkItem(work_item_id, { system: "action_spine-error", error: e.message });
    return;
  }

  // 1. Timer: "Подождать N минут"
  const waitMinutes = parseWaitMinutes(label);
  if (waitMinutes !== null) {
    const wakeAt = new Date(Date.now() + waitMinutes * 60 * 1000).toISOString();
    try {
      // TimerWait handles process-time advancement (deterministic state machine).
      // When wake_at is reached, tickTimerWaits() fires it and the case auto-advances.
      await createTimerWait({
        case_id,
        process_id,
        element_id,
        element_label: label,
        timer_type: "delay",
        wake_at: wakeAt,
        duration: `PT${waitMinutes}M`,
        auto_advance: true,
      });

      // Standalone reminder is purely a notification — does NOT advance the process.
      await createReminder({
        type: "standalone",
        recipient: "system",
        message: `Таймер: ${label} (work_item=${work_item_id})`,
        scheduled_at: wakeAt,
        channel: "gui",
        case_id,
        process_id,
        element_id,
        work_item_id,
      });

      log.info("timer set via TimerWait + notification reminder", {
        wait_minutes: waitMinutes,
        wake_at: wakeAt,
        work_item_id,
        process_advancement: "TimerWait (auto)",
        notification: "Reminder (standalone)",
      });
    } catch (e: any) {
      log.error("failed to create timer wait", { work_item_id, error: e.message });
      await completeWorkItem(work_item_id, { system: "timer-error", error: e.message }).catch(e2 => log.error("completeWorkItem failed for timer error", { work_item_id, error: e2?.message }));
    }
    return; // work item will be auto-completed by TimerWait when wake_at fires
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
      await completeWorkItem(work_item_id, { system: "gen-error", error: e.message }).catch(e2 => log.error("completeWorkItem failed for gen error", { work_item_id, error: e2?.message }));
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
      await completeWorkItem(work_item_id, { system: "bitrix-monitor-error", error: e.message }).catch(e2 => log.error("completeWorkItem failed for bitrix-monitor error", { work_item_id, error: e2?.message }));
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
