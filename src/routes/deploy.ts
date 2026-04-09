/**
 * deploy.ts — Auto-deploy endpoint (closes #297)
 *
 * POST /deploy
 *   Checks konoha:config:settings.auto_deploy before building.
 *   - auto_deploy: true  → runs `bun run build` in frontend/, returns result
 *   - auto_deploy: false → creates a GitHub PR via gh CLI, returns PR URL
 *
 * GET /deploy/status
 *   Returns last deploy result from Redis.
 *
 * GET/PUT /config/settings
 *   Read/write the settings object (auto_deploy, etc.)
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { redis } from "../redis";
import { exec } from "child_process";
import { promisify } from "util";
import { join } from "path";

const execAsync = promisify(exec);
const app = new Hono();

const SETTINGS_KEY = "konoha:config:settings";
const DEPLOY_STATUS_KEY = "konoha:deploy:last";
const FRONTEND_DIR = join(import.meta.dir, "../../frontend");
const GH_TOKEN_FILE = `${process.env.HOME || "/home/ubuntu"}/.github-token`;

interface Settings {
  auto_deploy?: boolean;
  [key: string]: unknown;
}

async function getSettings(): Promise<Settings> {
  try {
    const raw = await redis.get(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function setSettings(settings: Settings): Promise<void> {
  await redis.set(SETTINGS_KEY, JSON.stringify(settings));
}

async function readGhToken(): Promise<string> {
  try {
    const { readFileSync } = await import("fs");
    return readFileSync(GH_TOKEN_FILE, "utf-8").trim();
  } catch {
    return process.env.GH_TOKEN || "";
  }
}

// ── GET /config/settings ──────────────────────────────────────────────────────

app.get("/config/settings", requireAuth, async (c) => {
  const settings = await getSettings();
  return c.json(settings);
});

// ── PUT /config/settings ──────────────────────────────────────────────────────

app.put("/config/settings", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const current = await getSettings();
  const updated = { ...current, ...body };
  await setSettings(updated);
  return c.json(updated);
});

// ── GET /deploy/status ────────────────────────────────────────────────────────

app.get("/deploy/status", requireAuth, async (c) => {
  try {
    const raw = await redis.get(DEPLOY_STATUS_KEY);
    return c.json(raw ? JSON.parse(raw) : { status: "never_run" });
  } catch {
    return c.json({ status: "unknown" });
  }
});

// ── POST /deploy ──────────────────────────────────────────────────────────────

app.post("/deploy", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { force = false, branch, commit_sha } = body as {
    force?: boolean;
    branch?: string;
    commit_sha?: string;
  };

  const settings = await getSettings();
  const autoDeploy: boolean = force || settings.auto_deploy === true;

  const deployRecord: Record<string, unknown> = {
    triggered_at: new Date().toISOString(),
    auto_deploy: autoDeploy,
    branch: branch || "main",
    commit_sha: commit_sha || null,
  };

  if (!autoDeploy) {
    // Create a GitHub PR and wait for manual review
    try {
      const ghToken = await readGhToken();
      if (!ghToken) {
        const result = { ...deployRecord, status: "pr_skipped", reason: "no GH_TOKEN available" };
        await redis.set(DEPLOY_STATUS_KEY, JSON.stringify(result));
        return c.json(result);
      }

      const prTitle = `chore: deploy build${commit_sha ? ` (${commit_sha.slice(0, 7)})` : ""}`;
      const prBody = `Auto-deploy is disabled. This PR was created by the deploy endpoint.\n\nMerge to trigger manual deploy on the server.\n\nBranch: ${branch || "main"}${commit_sha ? `\nCommit: ${commit_sha}` : ""}`;

      const { stdout } = await execAsync(
        `GH_TOKEN=${ghToken} gh pr create --repo eaprelsky/konoha --title "${prTitle.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}" 2>&1`,
        { timeout: 30_000 },
      ).catch(e => ({ stdout: `PR creation failed: ${e.message}`, stderr: "" }));

      const prUrl = stdout.trim();
      const result = { ...deployRecord, status: "pr_created", pr_url: prUrl };
      await redis.set(DEPLOY_STATUS_KEY, JSON.stringify(result));
      return c.json(result);
    } catch (e: any) {
      const result = { ...deployRecord, status: "error", error: e.message };
      await redis.set(DEPLOY_STATUS_KEY, JSON.stringify(result));
      return c.json(result, 500);
    }
  }

  // auto_deploy: true → run build
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execAsync(
      `cd ${FRONTEND_DIR} && bun run build`,
      { timeout: 120_000 },
    );
    const elapsedMs = Date.now() - startedAt;
    const result = {
      ...deployRecord,
      status: "success",
      elapsed_ms: elapsedMs,
      stdout: stdout.slice(-2000),
      stderr: stderr.slice(-500),
    };
    await redis.set(DEPLOY_STATUS_KEY, JSON.stringify(result));
    console.log(`[deploy] Build succeeded in ${elapsedMs}ms`);
    return c.json(result);
  } catch (e: any) {
    const elapsedMs = Date.now() - startedAt;
    const result = {
      ...deployRecord,
      status: "failed",
      elapsed_ms: elapsedMs,
      error: e.message.slice(-1000),
    };
    await redis.set(DEPLOY_STATUS_KEY, JSON.stringify(result));
    console.error("[deploy] Build failed:", e.message.slice(0, 200));
    return c.json(result, 500);
  }
});

export default app;
