import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import type { HonoEnv } from "../types";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";

const TRUSTED_USERS_PATH = "/opt/shared/.trusted-users.json";
const TRUSTED_USERS_BACKUP_DIR = "/opt/shared/trusted-users-backups";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TrustedUser {
  name: string;
  telegram_id: number;
  username?: string | null;
  phone?: string | null;
  email?: string | null;
  position?: string;
  relation?: string;
  level?: number;
}

interface PendingEntry {
  type: "user" | "group";
  name?: string;
  telegram_id?: number;
  chat_id?: number;
  username?: string | null;
  last_seen?: string;
  source?: "direct" | "group";
  member_count?: number;
}

interface TrustedUsersFile {
  owner?: TrustedUser;
  trusted?: TrustedUser[];
  whitelisted_groups?: number[];
  blocked?: number[];
  pending?: PendingEntry[];
}

function readFile(): TrustedUsersFile {
  try {
    return JSON.parse(readFileSync(TRUSTED_USERS_PATH, "utf8"));
  } catch {
    return { trusted: [], whitelisted_groups: [], pending: [] };
  }
}

function writeFile(data: TrustedUsersFile): void {
  if (existsSync(TRUSTED_USERS_PATH)) {
    mkdirSync(TRUSTED_USERS_BACKUP_DIR, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(TRUSTED_USERS_PATH, `${TRUSTED_USERS_BACKUP_DIR}/trusted-users.${stamp}.json`);
  }
  const tmpPath = `${TRUSTED_USERS_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmpPath, TRUSTED_USERS_PATH);
}

// ── Router ────────────────────────────────────────────────────────────────────

const router = new Hono<HonoEnv>();

// GET /whitelist — current whitelist + pending entries
router.get("/", requireAuth, (c) => {
  const data = readFile();
  const trusted = (data.trusted ?? []).map(u => ({
    type: "user" as const,
    name: u.name,
    telegram_id: u.telegram_id,
    username: u.username ?? null,
    position: u.position ?? null,
    level: u.level ?? 2,
    status: "approved" as const,
  }));

  const groups = (data.whitelisted_groups ?? []).map(chat_id => ({
    type: "group" as const,
    chat_id,
    name: null,
    status: "approved" as const,
  }));

  const pending = (data.pending ?? []).map(p => ({
    ...p,
    status: "pending" as const,
  }));

  return c.json({
    owner: data.owner ?? null,
    trusted,
    whitelisted_groups: groups,
    pending,
  });
});

// POST /whitelist/approve — approve a pending entry (body: { type, telegram_id | chat_id })
router.post("/approve", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const data = readFile();
  const pending = data.pending ?? [];

  if (body.type === "user" && body.telegram_id) {
    const entry = pending.find(p => p.type === "user" && p.telegram_id === body.telegram_id);
    if (!entry) return c.json({ error: "Pending entry not found" }, 404);

    // Move to trusted
    data.trusted = data.trusted ?? [];
    data.trusted.push({
      name: entry.name ?? `User ${body.telegram_id}`,
      telegram_id: body.telegram_id,
      username: entry.username ?? null,
      level: 2,
    });
    data.pending = pending.filter(p => !(p.type === "user" && p.telegram_id === body.telegram_id));
    writeFile(data);
    return c.json({ ok: true, approved: "user", telegram_id: body.telegram_id });
  }

  if (body.type === "group" && body.chat_id) {
    const entry = pending.find(p => p.type === "group" && p.chat_id === body.chat_id);
    if (!entry) return c.json({ error: "Pending entry not found" }, 404);

    data.whitelisted_groups = data.whitelisted_groups ?? [];
    if (!data.whitelisted_groups.includes(body.chat_id)) {
      data.whitelisted_groups.push(body.chat_id);
    }
    data.pending = pending.filter(p => !(p.type === "group" && p.chat_id === body.chat_id));
    writeFile(data);
    return c.json({ ok: true, approved: "group", chat_id: body.chat_id });
  }

  return c.json({ error: "type and telegram_id/chat_id required" }, 400);
});

// POST /whitelist/reject — reject a pending entry (removes it + optionally blocks)
router.post("/reject", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const data = readFile();
  const pending = data.pending ?? [];

  if (body.type === "user" && body.telegram_id) {
    data.pending = pending.filter(p => !(p.type === "user" && p.telegram_id === body.telegram_id));
    if (body.block) {
      data.blocked = data.blocked ?? [];
      if (!data.blocked.includes(body.telegram_id)) data.blocked.push(body.telegram_id);
    }
    writeFile(data);
    return c.json({ ok: true, rejected: "user", telegram_id: body.telegram_id });
  }

  if (body.type === "group" && body.chat_id) {
    data.pending = pending.filter(p => !(p.type === "group" && p.chat_id === body.chat_id));
    if (body.block) {
      data.blocked = data.blocked ?? [];
      if (!data.blocked.includes(body.chat_id)) data.blocked.push(body.chat_id);
    }
    writeFile(data);
    return c.json({ ok: true, rejected: "group", chat_id: body.chat_id });
  }

  return c.json({ error: "type and telegram_id/chat_id required" }, 400);
});

// DELETE /whitelist/user/:telegram_id — remove user from trusted list
router.delete("/user/:telegram_id", requireAuth, (c) => {
  const raw = c.req.param("telegram_id");
  if (!raw) return c.json({ error: "telegram_id required" }, 400);
  const telegram_id = parseInt(raw, 10);
  if (isNaN(telegram_id)) return c.json({ error: "Invalid telegram_id" }, 400);

  const data = readFile();
  const before = (data.trusted ?? []).length;
  data.trusted = (data.trusted ?? []).filter(u => u.telegram_id !== telegram_id);
  if (data.trusted.length === before) return c.json({ error: "User not found" }, 404);
  writeFile(data);
  return c.json({ ok: true, removed: "user", telegram_id });
});

// DELETE /whitelist/group/:chat_id — remove group from whitelist
router.delete("/group/:chat_id", requireAuth, (c) => {
  const raw = c.req.param("chat_id");
  if (!raw) return c.json({ error: "chat_id required" }, 400);
  const chat_id = parseInt(raw, 10);
  if (isNaN(chat_id)) return c.json({ error: "Invalid chat_id" }, 400);

  const data = readFile();
  const before = (data.whitelisted_groups ?? []).length;
  data.whitelisted_groups = (data.whitelisted_groups ?? []).filter(id => id !== chat_id);
  if (data.whitelisted_groups.length === before) return c.json({ error: "Group not found" }, 404);
  writeFile(data);
  return c.json({ ok: true, removed: "group", chat_id });
});

export default router;
