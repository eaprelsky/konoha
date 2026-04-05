/**
 * trigger-resolver.ts — LLM-based event type classifier for workflow engine.
 *
 * Uses Claude Haiku with prompt caching to classify eEPC event labels into
 * structured trigger descriptors.
 *
 * Endpoints:
 *   POST /api/trigger-resolver/resolve
 *   POST /api/trigger-resolver/resolve-batch
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Hono } from "hono";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 300;

// ── System prompt (static — cached on first call) ────────────────────────────

const SYSTEM_PROMPT = `Ты — парсер событий бизнес-процесса в нотации eEPC.
Твоя задача: по текстовому описанию события (label) определить тип триггера и вернуть структурированный JSON-дескриптор.

ТИПЫ ТРИГГЕРОВ:

1. timer — периодическое или отложенное временное событие.
   Обязательные поля: cron (строка cron) ИЛИ delay_after (объект с ref_event и duration в ISO 8601).
   Маркеры в тексте: даты, дни недели, периоды, «каждый», «ежедневно», «через N дней», «в конце месяца».

2. message — внешнее входящее сообщение или событие из другой системы.
   Обязательные поля: source, filter.
   Маркеры: «получен», «пришёл», «поступила заявка», «клиент написал», упоминание внешних систем.

3. condition — срабатывание по условию на данных.
   Обязательные поля: data_source, query (entity, filter, metric), operator, threshold, poll_interval.
   Маркеры: «ниже», «выше», «превысил», «достиг порога», «если», «больше N», «меньше N», «нет открытых».

4. manual — действие человека.
   Обязательные поля: action (approve | reject | submit | complete | escalate), role.
   Маркеры: «согласовал», «утвердил», «отклонил», «заполнил», «проверил», должности и роли людей.

5. system — внутреннее событие движка процессов.
   Обязательные поля: event_name (process_completed | process_error | subprocess_completed | function_completed | all_branches_completed), process_ref или function_ref (опционально).
   Маркеры: «процесс завершён», «задача выполнена», «ошибка в процессе», ссылки на другие функции или подпроцессы из контекста.

ИЗВЕСТНЫЕ ИСТОЧНИКИ ДАННЫХ:

- bitrix — Битрикс24. CRM, сделки, лиды, задачи, контакты, компании.
  Для message: source = "bitrix", filter может содержать entity (lead, deal, task, contact, company), event (onCrmLeadAdd, onCrmDealUpdate, onTaskAdd, onTaskUpdate и т.д.).
  Для condition: data_source = "bitrix", query.entity, query.filter, query.metric (count, sum).

- telegram — Телеграм. Боты, каналы, сообщения.
  Для message: source = "telegram", filter может содержать message_type (text, callback, photo, document), chat_id, bot_name.
  Для condition: data_source = "telegram", query.metric (message_count и т.д.).

- tracker — Яндекс Трекер. Задачи, спринты, очереди, комментарии.
  Для message: source = "tracker", filter может содержать entity (issue, comment, sprint), event (created, status_changed, comment_added), queue, assignee.
  Для condition: data_source = "tracker", query.entity, query.filter (type, status, priority, queue), query.metric (count).

- bus — внутренняя шина Конохи. Сообщения от агентов.
  Для message: source = "bus", filter может содержать from_agent, message_type.

- webhook — generic вебхук от системы, не входящей в список известных.
  Для message: source = "webhook", filter свободный.

ПРАВИЛА:

- Если упоминается конкретная система из списка известных, используй соответствующий source/data_source с правильными полями filter/query.
- Если система не упомянута явно, но контекст процесса позволяет определить источник (например, процесс называется «Обработка лидов Битрикс»), используй его.
- Если событие идёт сразу после функции в контексте процесса и описывает её результат (например, функция «Сформировать отчёт» и следом событие «Отчёт сформирован»), это system-триггер с event_name = function_completed.
- Если текст неоднозначен, верни kind = "ambiguous" с полем candidates (массив вариантов с их confidence).
- Поле confidence обязательно, значение от 0.0 до 1.0.
- Отвечай ТОЛЬКО валидным JSON без пояснений, без markdown-обёрток.`;

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProcessContext {
  process_id?: string;
  process_name?: string;
  events?: { id: string; label: string }[];
  functions?: { id: string; label: string }[];
}

export interface TriggerDescriptor {
  kind: string;
  confidence: number;
  [key: string]: unknown;
}

// ── JSON Schema validation ───────────────────────────────────────────────────

const VALID_KINDS = new Set(["timer", "message", "condition", "manual", "system", "ambiguous"]);
const VALID_ACTIONS = new Set(["approve", "reject", "submit", "complete", "escalate"]);
const VALID_SYSTEM_EVENTS = new Set([
  "process_completed", "process_error", "subprocess_completed",
  "function_completed", "all_branches_completed",
]);
const VALID_OPERATORS = new Set([">", "<", ">=", "<=", "==", "!="]);

function validateTrigger(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const t = obj as Record<string, unknown>;
  if (!VALID_KINDS.has(t.kind as string)) return false;
  if (typeof t.confidence !== "number" || t.confidence < 0 || t.confidence > 1) return false;

  switch (t.kind) {
    case "timer":
      return typeof t.cron === "string" ||
        (!!t.delay_after && typeof (t.delay_after as any).duration === "string");
    case "message":
      return typeof t.source === "string" && t.filter !== undefined;
    case "condition": {
      const q = t.query as Record<string, unknown> | undefined;
      return typeof t.data_source === "string" &&
        !!q && typeof q.entity === "string" &&
        VALID_OPERATORS.has(t.operator as string) &&
        typeof t.threshold === "number" &&
        typeof t.poll_interval === "string";
    }
    case "manual":
      return VALID_ACTIONS.has(t.action as string) && typeof t.role === "string";
    case "system":
      return VALID_SYSTEM_EVENTS.has(t.event_name as string);
    case "ambiguous":
      return Array.isArray(t.candidates);
    default:
      return false;
  }
}

const AMBIGUOUS_FALLBACK: TriggerDescriptor = { kind: "ambiguous", candidates: [], confidence: 0 };

// ── Core resolve logic ────────────────────────────────────────────────────────

function buildUserMessage(label: string, ctx?: ProcessContext): string {
  const processName = ctx?.process_name ?? "не указано";
  const eventsList = ctx?.events?.length
    ? ctx.events.map(e => `  - ${e.id}: "${e.label}"`).join("\n")
    : "  нет данных";
  const fnList = ctx?.functions?.length
    ? ctx.functions.map(f => `  - ${f.id}: "${f.label}"`).join("\n")
    : "  нет данных";

  return `КОНТЕКСТ ПРОЦЕССА:
Название: ${processName}
События:
${eventsList}
Функции:
${fnList}

ТЕКСТ СОБЫТИЯ:
"${label}"`;
}

async function resolveLabel(label: string, ctx?: ProcessContext): Promise<TriggerDescriptor> {
  const userMessage = buildUserMessage(label, ctx);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ] as any,
    messages: [{ role: "user", content: userMessage }],
  });

  const raw = ((response.content[0] as any).text ?? "").trim();

  let parsed: unknown;
  try {
    const clean = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    console.warn(`[trigger-resolver] JSON parse error label="${label}": ${raw}`);
    return { ...AMBIGUOUS_FALLBACK };
  }

  if (!validateTrigger(parsed)) {
    console.warn(`[trigger-resolver] schema validation failed label="${label}": ${JSON.stringify(parsed)}`);
    return { ...AMBIGUOUS_FALLBACK };
  }

  return parsed as TriggerDescriptor;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerTriggerResolverRoutes(
  app: Hono<any>,
  requireAuth: (c: any, next: any) => Promise<any>,
): void {
  // POST /api/trigger-resolver/resolve
  app.post("/api/trigger-resolver/resolve", requireAuth, async (c) => {
    const body = await c.req.json<{
      label: string;
      process_context?: ProcessContext;
      manual_override?: boolean;
    }>().catch(() => null);

    if (!body?.label) return c.json({ error: "label required" }, 400);

    if (body.manual_override) {
      return c.json({ trigger: null, raw_label: body.label, skipped: true, reason: "manual_override" });
    }

    const processId = body.process_context?.process_id ?? "unknown";

    try {
      const trigger = await resolveLabel(body.label, body.process_context);
      console.log(`[trigger-resolver] resolve label="${body.label}" process_id=${processId} kind=${trigger.kind} confidence=${trigger.confidence}`);
      return c.json({ trigger, raw_label: body.label });
    } catch (e: any) {
      console.error(`[trigger-resolver] error label="${body.label}": ${e.message}`);
      return c.json({ trigger: { ...AMBIGUOUS_FALLBACK }, raw_label: body.label });
    }
  });

  // POST /api/trigger-resolver/resolve-batch
  app.post("/api/trigger-resolver/resolve-batch", requireAuth, async (c) => {
    const body = await c.req.json<{
      events: { id: string; label: string; manual_override?: boolean }[];
      process_context?: ProcessContext;
    }>().catch(() => null);

    if (!body?.events?.length) return c.json({ error: "events array required" }, 400);

    const processId = body.process_context?.process_id ?? "unknown";
    const results: { id: string; trigger: TriggerDescriptor | null }[] = [];

    for (const evt of body.events) {
      if (evt.manual_override) {
        results.push({ id: evt.id, trigger: null });
        continue;
      }
      try {
        const trigger = await resolveLabel(evt.label, body.process_context);
        console.log(`[trigger-resolver] batch id=${evt.id} label="${evt.label}" process_id=${processId} kind=${trigger.kind} confidence=${trigger.confidence}`);
        results.push({ id: evt.id, trigger });
      } catch (e: any) {
        console.error(`[trigger-resolver] batch error id=${evt.id}: ${e.message}`);
        results.push({ id: evt.id, trigger: { ...AMBIGUOUS_FALLBACK } });
      }
    }

    return c.json({ results });
  });
}
