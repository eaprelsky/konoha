import { Hono } from "hono";
import { requireAdmin } from "../middleware/auth";
import { buildPgReadReadinessReport } from "../pg-read-readiness";
import type { HonoEnv } from "../types";

const router = new Hono<HonoEnv>();

router.get("/pg-read-readiness", requireAdmin, async (c) => {
  return c.json(await buildPgReadReadinessReport());
});

export default router;
