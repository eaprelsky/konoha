/**
 * image.ts — Replicate-based image generation for avatar generation.
 * - Text → image: black-forest-labs/flux-schnell
 * - Image + text → image: black-forest-labs/flux-kontext-pro
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const AVATARS_DIR = "/opt/shared/attachments/avatars";
const REPLICATE_BASE = "https://api.replicate.com/v1";

export interface AvatarGenerationParams {
  id: string;
  name: string;
  description?: string;
  style?: string;
  prompt?: string;  // explicit prompt override
}

export interface AvatarImg2ImgParams {
  id: string;
  imageBase64: string;  // data:image/...;base64,...
  prompt: string;
}

export interface AvatarResult {
  avatar_url: string;
  local_path: string;
}

function buildPrompt(params: AvatarGenerationParams): string {
  if (params.prompt) return params.prompt;
  const base = params.style || "anime ninja character";
  const desc = params.description ? `, ${params.description}` : "";
  return `Portrait avatar of ${params.name}${desc}, ${base}, high quality, centered face, digital art`;
}

async function replicatePredict(model: string, input: Record<string, unknown>): Promise<string> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("REPLICATE_API_TOKEN not set");

  const res = await fetch(`${REPLICATE_BASE}/models/${model}/predictions`, {
    method: "POST",
    headers: {
      "Authorization": `Token ${token}`,
      "Content-Type": "application/json",
      "Prefer": "wait",
    },
    body: JSON.stringify({ input }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Replicate error ${res.status}: ${err}`);
  }

  let prediction = await res.json() as { id: string; status: string; output?: string[]; error?: string };

  // Poll if not immediately done (Prefer: wait may return early)
  const deadline = Date.now() + 120_000;
  while (prediction.status !== "succeeded" && prediction.status !== "failed" && prediction.status !== "canceled") {
    if (Date.now() > deadline) throw new Error("Replicate timeout (120s)");
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(`${REPLICATE_BASE}/predictions/${prediction.id}`, {
      headers: { "Authorization": `Token ${token}` },
    });
    if (!pollRes.ok) throw new Error(`Replicate poll error ${pollRes.status}`);
    prediction = await pollRes.json();
  }

  if (prediction.status !== "succeeded" || !prediction.output?.length) {
    throw new Error(`Replicate generation failed: ${prediction.error || prediction.status}`);
  }

  return prediction.output[0];
}

async function downloadAndSave(url: string, filename: string): Promise<string> {
  const imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error("Failed to download generated image");
  const buf = await imgRes.arrayBuffer();
  mkdirSync(AVATARS_DIR, { recursive: true });
  const localPath = join(AVATARS_DIR, filename);
  writeFileSync(localPath, Buffer.from(buf));
  return localPath;
}

export async function generateAvatar(params: AvatarGenerationParams): Promise<AvatarResult> {
  const prompt = buildPrompt(params);
  const imageUrl = await replicatePredict("black-forest-labs/flux-schnell", {
    prompt,
    num_outputs: 1,
    output_format: "webp",
  });
  const filename = `${params.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.webp`;
  const localPath = await downloadAndSave(imageUrl, filename);
  return {
    avatar_url: `/files/avatars/${filename}`,
    local_path: localPath,
  };
}

export async function generateAvatarImg2Img(params: AvatarImg2ImgParams): Promise<AvatarResult> {
  const imageUrl = await replicatePredict("black-forest-labs/flux-kontext-pro", {
    prompt: params.prompt,
    input_image: params.imageBase64,
  });
  const filename = `${params.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.webp`;
  const localPath = await downloadAndSave(imageUrl, filename);
  return {
    avatar_url: `/files/avatars/${filename}`,
    local_path: localPath,
  };
}
