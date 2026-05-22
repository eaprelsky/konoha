import { Hono } from "hono";
import { requireAdmin } from "../middleware/auth";
import { listOperationalAlerts } from "../operational-alerts";
import type { HonoEnv } from "../types";

const router = new Hono<HonoEnv>();

function positiveNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

router.get("/operational-alerts", requireAdmin, async (c) => {
  const receipt = await listOperationalAlerts({
    now: c.req.query("now") || undefined,
    stuck_case_warning_ms: positiveNumber(c.req.query("stuck_case_warning_ms")),
    stuck_case_critical_ms: positiveNumber(c.req.query("stuck_case_critical_ms")),
    limit: positiveNumber(c.req.query("limit")),
  });
  return c.json(receipt);
});

export default router;
