import { Hono } from "hono";
import { requireAuth, requireAdmin } from "../middleware/auth";
import type { HonoEnv } from "../types";
import { auditLog } from "../assistant-actions";
import {
  addWhitelistedGroup,
  approvePendingAccess,
  listAccess,
  rejectPendingAccess,
  removeTrustedUser,
  removeWhitelistedGroup,
  upsertTrustedUser,
} from "../access-control";
import { errorResponse } from "../errors";

const router = new Hono<HonoEnv>();

function auditBase(c: any, sessionPrefix: string) {
  const caller: { isAdmin: boolean; agentId: string | null } = c.get("caller");
  return {
    timestamp: new Date().toISOString(),
    session_id: c.req.header("x-request-id") ?? `${sessionPrefix}:${Date.now()}`,
    agent_chain: caller.isAdmin ? "admin->api" : `${caller.agentId ?? "unknown"}->api`,
  };
}

async function auditAccess(c: any, action_type: string, parameters: Record<string, unknown>) {
  await auditLog({
    ...auditBase(c, "access"),
    action_type,
    parameters: JSON.stringify(parameters),
    result: "ok",
  });
}

router.get("/", requireAuth, (c) => c.json(listAccess()));

router.post("/approve", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  try {
    const result = approvePendingAccess(body);
    await auditAccess(c, "access.approve", body);
    return c.json(result);
  } catch (e) {
    const { status, body: error } = errorResponse(e);
    return c.json(error, status as any);
  }
});

router.post("/reject", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  try {
    const result = rejectPendingAccess(body);
    await auditAccess(c, "access.reject", body);
    return c.json(result);
  } catch (e) {
    const { status, body: error } = errorResponse(e);
    return c.json(error, status as any);
  }
});

router.post("/user", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  try {
    const result = upsertTrustedUser(body);
    await auditAccess(c, "access.upsert_user", body);
    return c.json(result);
  } catch (e) {
    const { status, body: error } = errorResponse(e);
    return c.json(error, status as any);
  }
});

router.post("/group", requireAdmin, async (c) => {
  const body = await c.req.json<{ chat_id?: number }>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  try {
    const result = addWhitelistedGroup(Number(body.chat_id));
    await auditAccess(c, "access.add_group", body as Record<string, unknown>);
    return c.json(result);
  } catch (e) {
    const { status, body: error } = errorResponse(e);
    return c.json(error, status as any);
  }
});

router.delete("/user/:telegram_id", requireAdmin, async (c) => {
  const telegram_id = Number(c.req.param("telegram_id"));
  try {
    const result = removeTrustedUser(telegram_id);
    await auditAccess(c, "access.remove_user", { telegram_id });
    return c.json(result);
  } catch (e) {
    const { status, body } = errorResponse(e);
    return c.json(body, status as any);
  }
});

router.delete("/group/:chat_id", requireAdmin, async (c) => {
  const chat_id = Number(c.req.param("chat_id"));
  try {
    const result = removeWhitelistedGroup(chat_id);
    await auditAccess(c, "access.remove_group", { chat_id });
    return c.json(result);
  } catch (e) {
    const { status, body } = errorResponse(e);
    return c.json(body, status as any);
  }
});

export default router;
