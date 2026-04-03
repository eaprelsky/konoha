/**
 * image.ts — OpenRouter image generation (Flux Schnell) for avatar generation.
 * Used by POST /agents/:id/avatar and POST /people/:id/avatar
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const AVATARS_DIR = "/opt/shared/attachments/avatars";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "black-forest-labs/flux-schnell";

export interface AvatarGenerationParams {
  id: string;         // agent or person ID (used as filename)
  name: string;       // display name
  description?: string; // role / personality description
  style?: string;     // e.g. "anime ninja", "professional photo"
}

export interface AvatarResult {
  avatar_url: string;  // public URL path, e.g. /attachments/avatars/{id}.png
  local_path: string;
}

function buildPrompt(params: AvatarGenerationParams): string {
  const base = params.style || "anime ninja character";
  const desc = params.description ? `, ${params.description}` : "";
  return `Portrait avatar of ${params.name}${desc}, ${base}, high quality, centered face, digital art`;
}

export async function generateAvatar(params: AvatarGenerationParams): Promise<AvatarResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const prompt = buildPrompt(params);

  const res = await fetch(`${OPENROUTER_BASE}/images/generations`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://konoha.comind.tech",
      "X-Title": "Konoha WE",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      prompt,
      n: 1,
      response_format: "b64_json",
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    if (res.status === 404 || errBody.includes("not found") || errBody.includes("does not exist")) {
      throw new Error("Генерация аватаров временно недоступна — провайдер изображений недоступен");
    }
    throw new Error(`Генерация аватаров временно недоступна (${res.status})`);
  }

  const data = await res.json() as { data: { b64_json?: string; url?: string }[] };
  if (!data.data || data.data.length === 0) {
    throw new Error("Генерация аватаров временно недоступна — пустой ответ от провайдера");
  }

  mkdirSync(AVATARS_DIR, { recursive: true });
  const filename = `${params.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
  const localPath = join(AVATARS_DIR, filename);

  const item = data.data[0];
  if (item.b64_json) {
    writeFileSync(localPath, Buffer.from(item.b64_json, "base64"));
  } else if (item.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new Error("Failed to download image from URL");
    const buf = await imgRes.arrayBuffer();
    writeFileSync(localPath, Buffer.from(buf));
  } else {
    throw new Error("Генерация аватаров временно недоступна — нет данных изображения в ответе");
  }

  return {
    avatar_url: `/files/avatars/${filename}`,
    local_path: localPath,
  };
}
