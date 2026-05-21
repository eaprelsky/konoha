import { Hono } from "hono";
import { getRuntimeEffect, listRuntimeEffectsByStatus, recoverRuntimeEffect, RuntimeEffectRecoveryError } from "../runtime-effect-outbox";
import type { RuntimeEffectStatus } from "../runtime-effect-outbox";
import { requireAdmin } from "../middleware/auth";
import type { HonoEnv } from "../types";

const router = new Hono<HonoEnv>();

const VALID_STATUSES = new Set<RuntimeEffectStatus>([
  "pending",
  "in_flight",
  "succeeded",
  "failed",
  "retry",
  "dead_letter",
  "cancelled",
]);

function parseLimit(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : 50;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) return 50;
  return parsed;
}

function parseStatuses(raw: string | undefined): RuntimeEffectStatus[] {
  const values = (raw ?? "pending,retry,failed,dead_letter")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  const statuses = values.filter((value): value is RuntimeEffectStatus => VALID_STATUSES.has(value as RuntimeEffectStatus));
  return statuses.length ? statuses : ["pending", "retry", "failed", "dead_letter"];
}

async function parseRecoveryBody(c: any): Promise<{ actor: string; reason: string; now?: string }> {
  const body = await c.req.json().catch(() => ({}));
  return {
    actor: typeof body.actor === "string" ? body.actor : "api:admin",
    reason: typeof body.reason === "string" ? body.reason : "",
    ...(typeof body.now === "string" ? { now: body.now } : {}),
  };
}

function recoveryErrorResponse(c: any, e: unknown) {
  if (e instanceof RuntimeEffectRecoveryError) {
    return c.json({ ok: false, error: e.code, message: e.message, details: e.details }, e.status as any);
  }
  const message = e instanceof Error ? e.message : String(e);
  return c.json({ ok: false, error: "RUNTIME_EFFECT_RECOVERY_FAILED", message }, 500);
}

router.get("/runtime-effects", requireAdmin, async (c) => {
  const statuses = parseStatuses(c.req.query("status"));
  const limit = parseLimit(c.req.query("limit"));
  const listed = await Promise.all(statuses.map(status => listRuntimeEffectsByStatus(status, { limit })));
  const effects = listed.flat().sort((a, b) => a.updated_at.localeCompare(b.updated_at)).slice(0, limit);
  return c.json({ ok: true, statuses, limit, effects });
});

router.get("/runtime-effects/:id", requireAdmin, async (c) => {
  const effectId = c.req.param("id");
  if (!effectId) return c.json({ ok: false, error: "RUNTIME_EFFECT_NOT_FOUND" }, 404);
  const effect = await getRuntimeEffect(effectId);
  if (!effect) return c.json({ ok: false, error: "RUNTIME_EFFECT_NOT_FOUND" }, 404);
  return c.json({ ok: true, effect });
});

router.post("/runtime-effects/:id/retry", requireAdmin, async (c) => {
  try {
    const effectId = c.req.param("id");
    if (!effectId) return c.json({ ok: false, error: "RUNTIME_EFFECT_NOT_FOUND" }, 404);
    const body = await parseRecoveryBody(c);
    const receipt = await recoverRuntimeEffect(effectId, { operation: "retry", ...body });
    return c.json({ ok: true, receipt });
  } catch (e) {
    return recoveryErrorResponse(c, e);
  }
});

router.post("/runtime-effects/:id/cancel", requireAdmin, async (c) => {
  try {
    const effectId = c.req.param("id");
    if (!effectId) return c.json({ ok: false, error: "RUNTIME_EFFECT_NOT_FOUND" }, 404);
    const body = await parseRecoveryBody(c);
    const receipt = await recoverRuntimeEffect(effectId, { operation: "cancel", ...body });
    return c.json({ ok: true, receipt });
  } catch (e) {
    return recoveryErrorResponse(c, e);
  }
});

router.post("/runtime-effects/:id/dead-letter", requireAdmin, async (c) => {
  try {
    const effectId = c.req.param("id");
    if (!effectId) return c.json({ ok: false, error: "RUNTIME_EFFECT_NOT_FOUND" }, 404);
    const body = await parseRecoveryBody(c);
    const receipt = await recoverRuntimeEffect(effectId, { operation: "dead_letter", ...body });
    return c.json({ ok: true, receipt });
  } catch (e) {
    return recoveryErrorResponse(c, e);
  }
});

export default router;
