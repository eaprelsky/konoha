import { Hono } from "hono";
import { writeFileSync } from "fs";
import { extname, join } from "path";
import type { HonoEnv } from "../types";
import { requireAdmin } from "../middleware/auth";
import { redis } from "../redis";
import { auditLog } from "../assistant-actions";
import { dashboardAuthUsername, verifyDashboardCookie } from "../dashboard-auth";
import { generateAvatar, generateAvatarImg2Img } from "../adapters/image";

const PROFILE_KEY_PREFIX = "dashboard:profiles:";
const AVATARS_DIR = "/opt/shared/avatars";

interface DashboardProfile {
  username: string;
  display_name: string;
  position?: string;
  email?: string;
  telegram_username?: string;
  telegram_id?: number;
  person_id?: string;
  avatar_url?: string;
  capabilities?: string[];
  updated_at?: string;
}

const router = new Hono<HonoEnv>();

function usernameFromRequest(c: any): string {
  const session = verifyDashboardCookie(c.req.header("cookie"));
  return session?.sub || dashboardAuthUsername();
}

function profileKey(username: string): string {
  return `${PROFILE_KEY_PREFIX}${username}`;
}

function cleanProfile(username: string, body: Partial<DashboardProfile>): DashboardProfile {
  return {
    username,
    display_name: body.display_name?.trim() || body.username || username,
    position: body.position?.trim() || undefined,
    email: body.email?.trim() || undefined,
    telegram_username: body.telegram_username?.trim().replace(/^@/, "") || undefined,
    telegram_id: typeof body.telegram_id === "number" ? body.telegram_id : undefined,
    person_id: body.person_id?.trim() || undefined,
    avatar_url: body.avatar_url?.trim() || undefined,
    capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter(Boolean) : undefined,
    updated_at: new Date().toISOString(),
  };
}

async function loadProfile(username: string): Promise<DashboardProfile> {
  const raw = await redis.get(profileKey(username)).catch(() => null);
  if (!raw) return cleanProfile(username, {});
  return { ...cleanProfile(username, {}), ...JSON.parse(raw) };
}

async function saveProfile(profile: DashboardProfile): Promise<void> {
  await redis.set(profileKey(profile.username), JSON.stringify(profile));
}

async function auditProfile(c: any, action_type: string, parameters: Record<string, unknown>): Promise<void> {
  await auditLog({
    timestamp: new Date().toISOString(),
    session_id: c.req.header("x-request-id") ?? `${action_type}:${Date.now()}`,
    action_type,
    parameters: JSON.stringify(parameters),
    result: "ok",
    agent_chain: "dashboard->api",
  });
}

router.get("/profile/me", requireAdmin, async (c) => {
  const username = usernameFromRequest(c);
  return c.json(await loadProfile(username));
});

router.put("/profile/me", requireAdmin, async (c) => {
  const username = usernameFromRequest(c);
  const body = await c.req.json<Partial<DashboardProfile>>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const current = await loadProfile(username);
  const profile = cleanProfile(username, { ...current, ...body, username });
  await saveProfile(profile);
  await auditProfile(c, "dashboard.profile.update", {
    username,
    person_id: profile.person_id,
    fields: Object.keys(body).filter(key => key !== "username"),
  });
  return c.json(profile);
});

router.post("/profile/me/avatar", requireAdmin, async (c) => {
  const username = usernameFromRequest(c);
  const profile = await loadProfile(username);
  const contentType = c.req.header("content-type") || "";

  async function saveAvatar(avatar_url: string) {
    const updated = { ...profile, avatar_url, updated_at: new Date().toISOString() };
    await saveProfile(updated);
    await auditProfile(c, "dashboard.profile.avatar.update", { username });
    return c.json({ avatar_url });
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return c.json({ error: "file required" }, 400);
    const ext = extname(file.name).toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
      return c.json({ error: "Only jpg/png/gif/webp allowed" }, 415);
    }
    const prompt = formData.get("prompt") as string | null;
    if (prompt) {
      const buf = Buffer.from(await file.arrayBuffer());
      const mime = file.type || "image/jpeg";
      const imageBase64 = `data:${mime};base64,${buf.toString("base64")}`;
      const result = await generateAvatarImg2Img({ id: username, imageBase64, prompt });
      return saveAvatar(result.avatar_url);
    }

    const filename = `profile_${username.replace(/[^a-zA-Z0-9@.-]/g, "_")}_${Date.now()}${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    writeFileSync(join(AVATARS_DIR, filename), buf);
    return saveAvatar(`/api/avatars/${filename}`);
  }

  const body: { style?: string; description?: string; prompt?: string } =
    await c.req.json<{ style?: string; description?: string; prompt?: string }>().catch(() => ({}));
  const result = await generateAvatar({
    id: username,
    name: profile.display_name || username,
    description: body.description || profile.position,
    style: body.style,
    prompt: body.prompt,
  });
  return saveAvatar(result.avatar_url);
});

export default router;
