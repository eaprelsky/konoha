/**
 * audit.ts — Audit log + GitHub issue creation routes (closes #294)
 *
 * GET  /audit            — read audit log with filters
 * POST /github/issues    — create GitHub issue via assistant
 * GET  /config/autonomy  — read autonomy matrix
 * PUT  /config/autonomy  — update autonomy matrix
 */

import { Hono } from "hono";
import { config } from "../config";
import { createLogger } from "../logger";
import { requireAuth, requireAdmin, resolveAuth } from "../middleware/auth";
import { redis } from "../redis";
import type { HonoEnv } from "../types";
import {
  readAuditLog,
  auditLog,
  assistantCreateIssue,
  getAutonomyMatrix,
  setAutonomyLevel,
  type AutonomyLevel,
} from "../assistant-actions";
const log = createLogger("routes:audit");

const router = new Hono<HonoEnv>();

// ── Audit Log ──────────────────────────────────────────────────────────────────

router.use("/audit", requireAuth);
router.get("/audit", async (c) => {
  const { from_date, to_date, action_type, agent, limit } = c.req.query();
  try {
    const entries = await readAuditLog({
      fromDate: from_date,
      toDate: to_date,
      actionType: action_type,
      agent,
      limit: limit ? parseInt(limit) : 200,
    });
    return c.json(entries);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── GitHub Issue Creation ──────────────────────────────────────────────────────

router.use("/github/issues", requireAuth);
router.post("/github/issues", async (c) => {
  const body = await c.req.json<{
    title: string;
    body: string;
    priority?: "P0: critical" | "P1: high" | "P2: medium" | "P3: low";
    labels?: string[];
    session_id?: string;
  }>().catch(() => null);

  if (!body?.title?.trim() || !body?.body?.trim()) {
    return c.json({ error: "title and body required" }, 400);
  }

  try {
    const result = await assistantCreateIssue({
      title: body.title,
      body: body.body,
      priority: body.priority,
      labels: body.labels,
      session_id: body.session_id,
      agent_chain: "assistant→api",
    });
    if (result.requires_confirm) {
      return c.json({ requires_confirm: true, message: "Action requires user confirmation per autonomy matrix" }, 202);
    }
    return c.json(result, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── Autonomy Matrix ────────────────────────────────────────────────────────────

router.use("/config/autonomy", requireAuth);

router.get("/config/autonomy", async (c) => {
  try {
    const matrix = await getAutonomyMatrix();
    return c.json(matrix);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

router.put("/config/autonomy", requireAdmin, async (c) => {
  const body = await c.req.json<Record<string, AutonomyLevel>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid body" }, 400);
  const errors: string[] = [];
  for (const [actionType, level] of Object.entries(body)) {
    try {
      await setAutonomyLevel(actionType, level);
    } catch (e: any) {
      errors.push(e.message);
    }
  }
  if (errors.length > 0) return c.json({ errors }, 400);
  return c.json({ ok: true });
});

// ── Branding (closes #298) ────────────────────────────────────────────────────

const BRANDING_KEY = "konoha:config:branding";

export interface BrandingConfig {
  product_name?: string;
  /** @deprecated Use assistant_agent_id instead */
  assistant_name?: string;
  /** @deprecated Use assistant_agent_id instead */
  assistant_avatar?: string;
  assistant_agent_id?: string;
  agent_display_names?: Record<string, string>;
  theme?: {
    primary_color?: string;
    accent_color?: string;
    logo_url?: string;
  };
}

const BRANDING_DEFAULTS: BrandingConfig = {
  product_name: "Konoha WE",
  agent_display_names: {},
  theme: { primary_color: "#6366f1", accent_color: "#f59e0b" },
};

export async function getBranding(): Promise<BrandingConfig> {
  try {
    const raw = await redis.get(BRANDING_KEY);
    return raw ? { ...BRANDING_DEFAULTS, ...JSON.parse(raw) } : { ...BRANDING_DEFAULTS };
  } catch {
    return { ...BRANDING_DEFAULTS };
  }
}

// GET /branding — public (used by frontend at startup)
router.get("/branding", async (c) => {
  return c.json(await getBranding());
});

// PUT /branding — admin-only. Branding is user-visible and must not be writable
// by regular agent tokens.
router.put("/branding", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid body" }, 400);
  const current = await getBranding();
  const updated: BrandingConfig = {
    ...current,
    ...body,
    theme: { ...current.theme, ...(body.theme ?? {}) },
    agent_display_names: { ...current.agent_display_names, ...(body.agent_display_names ?? {}) },
  };
  await redis.set(BRANDING_KEY, JSON.stringify(updated));
  const caller: { isAdmin: boolean; agentId: string | null } = c.get("caller");
  await auditLog({
    timestamp: new Date().toISOString(),
    session_id: c.req.header("x-request-id") ?? `branding:${Date.now()}`,
    action_type: "branding.update",
    parameters: JSON.stringify({
      product_name: updated.product_name,
      theme_fields: Object.keys(body.theme ?? {}),
      agent_display_name_ids: Object.keys(body.agent_display_names ?? {}),
    }),
    result: "ok",
    agent_chain: caller.isAdmin ? "admin->api" : `${caller.agentId ?? "unknown"}->api`,
  });
  return c.json(updated);
});

// ── Setup Wizard (closes #295) ─────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SETUP_FILE = config.paths.setupFile;

interface SetupConfig {
  complete: boolean;
  owner_tg_id?: string;
  llm_provider?: string;
  github_pat?: string;
  github_repo?: string;
  admin_token_hash?: string;
  completed_at?: string;
}

function readSetup(): SetupConfig {
  try {
    if (existsSync(SETUP_FILE)) return JSON.parse(readFileSync(SETUP_FILE, "utf-8"));
  } catch {}
  return { complete: false };
}

function writeSetup(cfg: SetupConfig): void {
  writeFileSync(SETUP_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// GET /setup/status — public (no auth needed before setup is complete)
router.get("/setup/status", async (c) => {
  const cfg = readSetup();
  const missing: string[] = [];
  if (!cfg.owner_tg_id) missing.push("owner_tg_id");
  if (!cfg.llm_provider) missing.push("llm_provider");
  if (!cfg.github_repo) missing.push("github_repo");
  return c.json({ complete: cfg.complete, missing_fields: missing });
});

// POST /setup — public only for first-time setup; completed installs require admin.
router.post("/setup", async (c) => {
  const body = await c.req.json<{
    owner_tg_id?: string;
    llm_api_key?: string;
    llm_provider?: string;
    github_pat?: string;
    github_repo?: string;
    admin_token?: string;
  }>().catch(() => null);

  if (!body) return c.json({ error: "invalid body" }, 400);

  const existing = readSetup();
  if (existing.complete) {
    const caller = await resolveAuth(c);
    if (!caller?.isAdmin) return c.json({ error: "Forbidden: setup is already complete" }, 403);
  }

  // Write env-level secrets to shared credentials (append/update)
  // We store non-secret metadata in setup file; actual secrets go to .shared-credentials
  const CREDS_FILE = "/opt/shared/.shared-credentials";
  if (body.llm_api_key) {
    try {
      let creds = existsSync(CREDS_FILE) ? readFileSync(CREDS_FILE, "utf-8") : "";
      // Update or append ANTHROPIC_API_KEY line
      if (creds.includes("ANTHROPIC_API_KEY=")) {
        creds = creds.replace(/ANTHROPIC_API_KEY=.*/, `ANTHROPIC_API_KEY=${body.llm_api_key}`);
      } else {
        creds += `\nANTHROPIC_API_KEY=${body.llm_api_key}`;
      }
      writeFileSync(CREDS_FILE, creds.trim() + "\n", { mode: 0o600 });
    } catch (e: any) {
      log.warn("could not write creds", { error: e.message });
    }
  }

  if (body.github_pat) {
    try {
      writeFileSync("/root/.github-token", body.github_pat.trim(), { mode: 0o600 });
    } catch {}
    try {
      writeFileSync("/home/ubuntu/.github-token", body.github_pat.trim(), { mode: 0o600 });
    } catch {}
  }

  const updated: SetupConfig = {
    ...existing,
    complete: true,
    completed_at: new Date().toISOString(),
    owner_tg_id: body.owner_tg_id ?? existing.owner_tg_id,
    llm_provider: body.llm_provider ?? existing.llm_provider ?? "anthropic",
    github_repo: body.github_repo ?? existing.github_repo,
  };

  writeSetup(updated);
  return c.json({ ok: true, complete: true });
});

export default router;
