import { redis } from "./redis";

const DOC_KEY_PREFIX = "doc:";

export async function loadInstructionText(docIds: string[], fallback = ""): Promise<string> {
  if (!docIds.length) return fallback;
  const texts: string[] = [];
  for (const id of docIds) {
    try {
      const raw = await redis.get(DOC_KEY_PREFIX + id);
      if (!raw) continue;
      const doc = JSON.parse(raw) as { name?: string; content?: string };
      if (doc.content) texts.push(`[${doc.name || id}]\n${doc.content}`);
    } catch {
      continue;
    }
  }
  return texts.length ? texts.join("\n\n") : fallback;
}
