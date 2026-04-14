import { generateText } from "./llm";

export async function normalizeElementNames(
  elements: Array<{ id: string; type: string; label: string }>
): Promise<Record<string, string>> {
  const toNormalize = elements.filter(e => e.type === "function" || e.type === "event");
  if (!toNormalize.length) return {};

  const prompt = `Нормализуй названия элементов бизнес-процесса по правилам:
- Функции (type=function): название должно быть глаголом в инфинитиве ("Подписать документ", "Отправить заявку")
- События (type=event): название должно быть существительным или причастием совершенного вида ("Документ подписан", "Заявка отправлена")

Элементы для нормализации:
${toNormalize.map(e => `- id=${e.id} type=${e.type} label="${e.label}"`).join("\n")}

Ответь ТОЛЬКО JSON-объектом вида {"id": "нормализованное название", ...}. Без пояснений.`;

  const text = await generateText({
    model: "claude-haiku-4-5-20251001",
    maxTokens: 500,
    messages: [{ role: "user", content: prompt }],
  });
  return JSON.parse(text);
}
