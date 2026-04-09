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

export default router;
