/**
 * audit.ts — Audit log + GitHub issue creation routes (closes #294)
 *
 * GET  /audit            — read audit log with filters
 * POST /github/issues    — create GitHub issue via assistant
 * GET  /config/autonomy  — read autonomy matrix
 * PUT  /config/autonomy  — update autonomy matrix
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import {
  readAuditLog,
  assistantCreateIssue,
  getAutonomyMatrix,
  setAutonomyLevel,
  type AutonomyLevel,
} from "../assistant-actions";

const router = new Hono();

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

router.put("/config/autonomy", async (c) => {
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

// ── Setup Wizard (closes #295) ─────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SETUP_FILE = process.env.KONOHA_SETUP_FILE ?? "/opt/shared/.konoha-setup.json";

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
  return c.json({ complete: cfg.complete });
});

// POST /setup — save wizard config (no auth required to allow first-time setup)
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
      console.warn("[setup] could not write creds:", e.message);
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
