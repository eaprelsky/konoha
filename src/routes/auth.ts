import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { HonoEnv } from "../types";
import { auditLog } from "../assistant-actions";
import { redis } from "../redis";
import {
  DASHBOARD_SESSION_TTL_SECONDS,
  createDashboardSession,
  dashboardAuthUsername,
  dashboardSessionCookieName,
  setDashboardPassword,
  verifyDashboardPassword,
  verifyDashboardSessionToken,
} from "../dashboard-auth";

const router = new Hono<HonoEnv>();
const LOGIN_RATE_LIMIT = { limit: 10, windowSeconds: 5 * 60 };
const PASSWORD_RATE_LIMIT = { limit: 5, windowSeconds: 5 * 60 };

function secureCookie(c: any): boolean {
  return c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
}

function clientIp(c: any): string {
  return (c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "local")
    .split(",")[0]
    .trim()
    .replace(/[^a-zA-Z0-9:._-]/g, "_");
}

function rateKey(action: string, c: any, subject: string): string {
  return `dashboard:rate:${action}:${clientIp(c)}:${subject || "unknown"}`;
}

async function hitRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count > limit;
}

router.post("/auth/login", async (c) => {
  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => null);
  const username = body?.username?.trim() ?? "";
  const password = body?.password ?? "";
  const loginRateKey = rateKey("login", c, username);
  if (await hitRateLimit(loginRateKey, LOGIN_RATE_LIMIT.limit, LOGIN_RATE_LIMIT.windowSeconds)) {
    await auditLog({
      timestamp: new Date().toISOString(),
      session_id: c.req.header("x-request-id") ?? `auth-rate:${Date.now()}`,
      action_type: "dashboard.login",
      parameters: JSON.stringify({ username, reason: "rate_limited" }),
      result: "blocked",
      agent_chain: "dashboard->api",
    });
    return c.json({ error: "Too many login attempts" }, 429);
  }
  const ok = await verifyDashboardPassword(username, password);

  await auditLog({
    timestamp: new Date().toISOString(),
    session_id: c.req.header("x-request-id") ?? `auth:${Date.now()}`,
    action_type: "dashboard.login",
    parameters: JSON.stringify({ username }),
    result: ok ? "ok" : "blocked",
    agent_chain: "dashboard->api",
  });

  if (!ok) return c.json({ error: "Invalid username or password" }, 401);
  await redis.del(loginRateKey).catch(() => undefined);

  setCookie(c, dashboardSessionCookieName(), createDashboardSession(username), {
    httpOnly: true,
    secure: secureCookie(c),
    sameSite: "Lax",
    path: "/",
    maxAge: DASHBOARD_SESSION_TTL_SECONDS,
  });
  return c.json({ ok: true, username });
});

router.get("/auth/me", async (c) => {
  const session = verifyDashboardSessionToken(getCookie(c, dashboardSessionCookieName()));
  if (!session) return c.json({ authenticated: false }, 401);
  return c.json({ authenticated: true, username: session.sub });
});

router.post("/auth/logout", async (c) => {
  deleteCookie(c, dashboardSessionCookieName(), { path: "/" });
  return c.json({ ok: true });
});

router.post("/auth/password", async (c) => {
  const session = verifyDashboardSessionToken(getCookie(c, dashboardSessionCookieName()));
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json<{ current_password?: string; new_password?: string }>().catch(() => null);
  const currentPassword = body?.current_password ?? "";
  const newPassword = body?.new_password ?? "";
  const username = dashboardAuthUsername();
  const passwordRateKey = rateKey("password", c, session.sub);
  if (await hitRateLimit(passwordRateKey, PASSWORD_RATE_LIMIT.limit, PASSWORD_RATE_LIMIT.windowSeconds)) {
    await auditLog({
      timestamp: new Date().toISOString(),
      session_id: c.req.header("x-request-id") ?? `auth-password-rate:${Date.now()}`,
      action_type: "dashboard.password.update",
      parameters: JSON.stringify({ username, reason: "rate_limited" }),
      result: "blocked",
      agent_chain: "dashboard->api",
    });
    return c.json({ error: "Too many password change attempts" }, 429);
  }

  if (!(await verifyDashboardPassword(username, currentPassword))) {
    return c.json({ error: "Current password is invalid" }, 403);
  }
  if (newPassword.length < 12) {
    return c.json({ error: "New password must be at least 12 characters" }, 400);
  }

  await setDashboardPassword(newPassword);
  await redis.del(passwordRateKey).catch(() => undefined);
  await auditLog({
    timestamp: new Date().toISOString(),
    session_id: c.req.header("x-request-id") ?? `auth-password:${Date.now()}`,
    action_type: "dashboard.password.update",
    parameters: JSON.stringify({ username }),
    result: "ok",
    agent_chain: "dashboard->api",
  });

  return c.json({ ok: true });
});

export default router;
