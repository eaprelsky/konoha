import type { Context, Next } from "hono";
import { config } from "../config";
import type { CallerInfo, HonoEnv } from "../types";
import { getAgentIdByToken } from "../redis";
import { verifyDashboardCookie } from "../dashboard-auth";

export const ADMIN_TOKEN = config.auth.adminToken;

// Resolve caller identity from Bearer token.
// Returns { isAdmin: true } for master token, or { isAdmin: false, agentId } for per-agent token.
// Returns null if token is missing or invalid.
export async function resolveAuth(c: Context<HonoEnv>): Promise<CallerInfo | null> {
  const dashboardSession = verifyDashboardCookie(c.req.header("cookie"));
  if (dashboardSession) return { isAdmin: true, agentId: null };

  const host = (c.req.header("host") || "").split(":")[0].toLowerCase();
  const isDashboardRequest = c.req.header("x-konoha-dashboard") === "1" || config.dashboard.hosts.includes(host);
  if (isDashboardRequest) return null;

  const auth = c.req.header("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  if (token === ADMIN_TOKEN) return { isAdmin: true, agentId: null };
  const agentId = await getAgentIdByToken(token);
  if (!agentId) return null;
  return { isAdmin: false, agentId };
}

// Middleware: require any valid auth (admin or agent token)
export async function requireAuth(c: Context<HonoEnv>, next: Next) {
  const caller = await resolveAuth(c);
  if (!caller) return c.json({ error: "Unauthorized" }, 401);
  c.set("caller", caller);
  await next();
}

// Middleware: require admin token only
export async function requireAdmin(c: Context<HonoEnv>, next: Next) {
  const caller = await resolveAuth(c);
  if (!caller || !caller.isAdmin) return c.json({ error: "Forbidden: admin token required" }, 403);
  c.set("caller", caller);
  await next();
}
