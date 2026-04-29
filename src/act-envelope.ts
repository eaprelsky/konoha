/**
 * act-envelope.ts — Unified action envelope for system operations (#500)
 *
 * A single external action shape that maps to current handlers/endpoints.
 * Used by API, MCP, assistant, and UI layers.
 *
 * Envelope design:
 *   - `act`  = mutations (create, update, delete, complete, close)
 *   - `inspect` = read-only queries (list, get, search, tree)
 *   - `drill` = navigate into details (case stream, history, versions)
 *
 * Migration path:
 *   Phase 1: envelope wraps current endpoints — no behavior change
 *   Phase 2: envelope becomes the primary API, old endpoints deprecated
 */

import { Hono } from "hono";
import type { HonoEnv } from "./types";
import { requireAuth } from "./middleware/auth";
import {
  ACTION_VERSION,
  classifyAction,
  getAction,
  isValidAction,
  validateActionArgs,
  type ActionCategory,
  type ActionDef,
} from "./action-registry";
import { auditLog, checkAutonomy } from "./assistant-actions";
import { assertActionArgs, executeActionDirect } from "./action-executor";

// ── Envelope types ───────────────────────────────────────────────────────────

export type ActCategory = ActionCategory;
export { classifyAction } from "./action-registry";

export interface ActEnvelope {
  /** Action ID from the registry (e.g. "workflow.create") */
  action: string;
  /** Category: act (mutation), inspect (read), drill (navigate) */
  category: ActCategory;
  /** Action arguments — validated against registry contract */
  args: Record<string, unknown>;
  /** Request metadata */
  meta?: {
    session_id?: string;
    agent_chain?: string;
    idempotency_key?: string;
  };
}

export interface ActResult {
  ok: boolean;
  action: string;
  data?: unknown;
  error?: string;
  status?: number;
  /** Whether the action requires confirmation before execution */
  requires_confirm?: boolean;
  /** The action definition used for this request */
  action_version: number;
}

export interface ActionExecutionContext {
  session_id: string;
  agent_chain: string;
}

export type ActionHandler = (
  args: Record<string, unknown>,
  ctx: ActionExecutionContext,
) => Promise<unknown>;

// ── Validation ───────────────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate envelope structure and arguments against the registry.
 */
export function validateEnvelope(envelope: ActEnvelope): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!envelope.action) {
    errors.push({ field: "action", message: "Action ID is required" });
    return errors;
  }

  if (!isValidAction(envelope.action)) {
    errors.push({ field: "action", message: `Unknown action: ${envelope.action}` });
    return errors;
  }

  if (!envelope.args || typeof envelope.args !== "object") {
    errors.push({ field: "args", message: "Args must be an object" });
    return errors;
  }

  const argsValidation = validateActionArgs(envelope.action, envelope.args);
  for (const message of argsValidation.errors) {
    errors.push({ field: "args", message });
  }

  // Verify category matches action
  const expectedCategory = classifyAction(envelope.action);
  if (envelope.category && envelope.category !== expectedCategory) {
    errors.push({
      field: "category",
      message: `Action ${envelope.action} is category '${expectedCategory}', not '${envelope.category}'`,
    });
  }

  return errors;
}

// ── Response builder ─────────────────────────────────────────────────────────

function ok(action: string, data: unknown, status = 200): ActResult {
  return { ok: true, action, data, status, action_version: ACTION_VERSION };
}

function fail(action: string, error: string): ActResult {
  return { ok: false, action, error, action_version: ACTION_VERSION };
}

function needConfirm(action: string): ActResult {
  return { ok: false, action, requires_confirm: true, action_version: ACTION_VERSION };
}

// ── Action handlers ──────────────────────────────────────────────────────────
// Workflow core actions execute directly. Remaining actions temporarily delegate
// to existing endpoints until their contracts are migrated.

const actionHandlers = new Map<string, ActionHandler>();

export function registerHandler(actionId: string, handler: ActionHandler): void {
  if (!isValidAction(actionId)) {
    throw new Error(`Cannot register handler for unknown action: ${actionId}`);
  }
  actionHandlers.set(actionId, handler);
}

async function executeRegisteredHandler(
  action: ActionDef,
  args: Record<string, unknown>,
  ctx: ActionExecutionContext,
): Promise<ActResult | null> {
  const handler = actionHandlers.get(action.id);
  if (!handler) return null;

  try {
    const data = await handler(args, ctx);
    if (classifyAction(action.id) === "act" && action.audited) {
      await auditLog({
        timestamp: new Date().toISOString(),
        session_id: ctx.session_id,
        action_type: action.id,
        parameters: JSON.stringify(args),
        result: "ok",
        agent_chain: ctx.agent_chain,
      });
    }
    return ok(action.id, data, action.id === "workflow.create" ? 201 : 200);
  } catch (e: any) {
    if (classifyAction(action.id) === "act" && action.audited) {
      await auditLog({
        timestamp: new Date().toISOString(),
        session_id: ctx.session_id,
        action_type: action.id,
        parameters: JSON.stringify(args),
        result: "error",
        agent_chain: ctx.agent_chain,
        error: e.message,
      });
    }
    return fail(action.id, e.message);
  }
}

export interface ExecuteActionOptions {
  session_id?: string;
  agent_chain?: string;
  skipAutonomy?: boolean;
  authHeader?: string;
}

export async function executeAction(
  envelope: ActEnvelope,
  opts: ExecuteActionOptions = {},
): Promise<ActResult> {
  const errors = validateEnvelope(envelope);
  if (errors.length > 0) {
    return fail(envelope.action ?? "unknown", `Validation: ${errors.map(e => e.message).join("; ")}`);
  }

  const action = getAction(envelope.action)!;
  const category = classifyAction(envelope.action);
  const sessionId = opts.session_id ?? envelope.meta?.session_id ?? crypto.randomUUID();
  const agentChain = opts.agent_chain ?? envelope.meta?.agent_chain ?? "api";
  const ctx = { session_id: sessionId, agent_chain: agentChain };

  if (category === "act" && !opts.skipAutonomy) {
    const autonomy = await checkAutonomy(envelope.action);
    if (autonomy === "disabled") {
      await auditLog({
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        action_type: envelope.action,
        parameters: JSON.stringify(envelope.args),
        result: "blocked",
        agent_chain: agentChain,
      });
      return fail(envelope.action, `Action ${envelope.action} is disabled`);
    }
    if (autonomy === "confirm") {
      await auditLog({
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        action_type: envelope.action,
        parameters: JSON.stringify(envelope.args),
        result: "requires_confirm",
        agent_chain: agentChain,
      });
      return needConfirm(envelope.action);
    }
  }

  const direct = await executeActionDirect(envelope.action, assertActionArgs(envelope.args));
  if (direct) {
    if (category === "act" && action.audited) {
      await auditLog({
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        action_type: envelope.action,
        parameters: JSON.stringify(envelope.args),
        result: direct.status >= 200 && direct.status < 300 ? "ok" : "error",
        agent_chain: agentChain,
        error: direct.status >= 200 && direct.status < 300 ? undefined : JSON.stringify(direct.data),
      });
    }
    return direct.status >= 200 && direct.status < 300
      ? ok(envelope.action, direct.data, direct.status)
      : fail(envelope.action, isRecordWithError(direct.data) ? direct.data.error : JSON.stringify(direct.data));
  }

  const registered = await executeRegisteredHandler(action, envelope.args, ctx);
  if (registered) return registered;

  const endpoint = resolveEndpoint(action, envelope.args);
  if (!endpoint) {
    return ok(envelope.action, {
      note: "Action registered but not yet wired to a direct handler or endpoint",
      definition: action,
    });
  }

  try {
    const baseUrl = `http://127.0.0.1:${process.env.KONOHA_PORT || 3200}`;
    const url = `${baseUrl}${endpoint.path}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.authHeader) headers.Authorization = opts.authHeader;
    const fetchOpts: RequestInit = { method: endpoint.method, headers };
    if (endpoint.body && ["POST", "PUT", "PATCH"].includes(endpoint.method)) {
      fetchOpts.body = JSON.stringify(endpoint.body);
    }
    const response = await fetch(url, fetchOpts);
    const data = await response.json().catch(() => null);
    if (category === "act" && action.audited) {
      await auditLog({
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        action_type: envelope.action,
        parameters: JSON.stringify(envelope.args),
        result: response.ok ? "ok" : "error",
        agent_chain: agentChain,
        error: response.ok ? undefined : JSON.stringify(data),
      });
    }
    if (!response.ok) {
      return fail(envelope.action, JSON.stringify(data ?? { status: response.status }));
    }
    return ok(envelope.action, data, response.status);
  } catch (e: any) {
    return fail(envelope.action, `Internal routing error: ${e.message}`);
  }
}

/**
 * Resolve the internal HTTP endpoint for an action.
 * Returns { method, path, body } for internal routing.
 */
function resolveEndpoint(action: ActionDef, args: Record<string, unknown>): {
  method: string;
  path: string;
  body?: Record<string, unknown>;
} | null {
  const ep = action.currentEndpoint;
  if (!ep) return null;

  const [method, pathTemplate] = ep.split(" ");
  if (!method || !pathTemplate) return null;

  // Replace path parameters (e.g. :id → actual value)
  let path = pathTemplate;
  const pathParams = pathTemplate.match(/:(\w+)/g) ?? [];
  for (const param of pathParams) {
    const key = param.slice(1); // remove colon
    // Map common param names to arg names
    const argKey = key === "id" ? findIdArg(action, args) : key;
    const value = args[argKey];
    if (value == null) return null;
    path = path.replace(param, String(value));
  }

  // Build body from non-path arguments
  const pathKeys = new Set(pathParams.map(p => {
    const key = p.slice(1);
    return key === "id" ? findIdArg(action, args) : key;
  }));

  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!pathKeys.has(k)) body[k] = v;
  }

  return { method, path, body: Object.keys(body).length > 0 ? body : undefined };
}

function findIdArg(action: ActionDef, args: Record<string, unknown>): string {
  // Try to find the right ID arg
  const idArg = action.args.find(a =>
    a.name.endsWith("_id") || a.name === "id" || a.name === "process_id"
  );
  if (idArg && args[idArg.name] != null) return idArg.name;
  return "id";
}

// ── Route handler ────────────────────────────────────────────────────────────

export const actRouter = new Hono<HonoEnv>();

/**
 * POST /act — Unified action endpoint.
 *
 * Accepts an ActEnvelope, validates it against the registry,
 * checks autonomy, and routes to the appropriate handler.
 */
actRouter.post("/", requireAuth, async (c) => {
  const envelope = await c.req.json<ActEnvelope>();
  const caller = c.get("caller");
  const actionDef = getAction(envelope.action);
  const category = actionDef ? classifyAction(actionDef.id) : classifyAction(envelope.action);
  if (!caller?.isAdmin && category === "act" && (actionDef?.scope === "access" || actionDef?.scope === "person")) {
    return c.json(fail(envelope.action, "Forbidden: admin token required"), 403);
  }
  const result = await executeAction(envelope, {
    agent_chain: envelope.meta?.agent_chain ?? "api",
    authHeader: c.req.header("Authorization"),
    skipAutonomy: caller?.isAdmin === true,
  });
  if (!result.ok && result.requires_confirm) {
    return c.json(result, 202);
  }
  if (!result.ok) {
    return c.json(result, result.error?.startsWith("Validation") ? 400 : 500);
  }
  return c.json(result, (result.status ?? 200) as any);
});

function isRecordWithError(value: unknown): value is { error: string } {
  return value !== null && typeof value === "object" && "error" in value && typeof (value as any).error === "string";
}

/**
 * POST /act/intent — Decompose a high-level intent into an action sequence.
 *
 * Body: { intent: string, params: Record<string, unknown> }
 * Returns: DecomposedPlan with ordered actions and side_effects.
 */
actRouter.post("/intent", requireAuth, async (c) => {
  const { intent, params } = await c.req.json<{ intent: string; params: Record<string, unknown> }>();
  if (!intent) {
    return c.json(fail("intent", "Missing required field: intent"), 400);
  }
  const { decomposeIntent, listIntents } = await import("./intent-decomposer");
  const plan = decomposeIntent(intent, params ?? {});
  if (!plan) {
    return c.json(fail(intent, `Unknown intent: ${intent}. Available: ${listIntents().map(i => i.id).join(", ")}`), 404);
  }
  return c.json({ ok: true, action: `intent.${intent}`, data: plan, action_version: ACTION_VERSION });
});

/**
 * GET /act/intent — List available intents.
 */
actRouter.get("/intent", requireAuth, async (c) => {
  const { listIntents } = await import("./intent-decomposer");
  return c.json(listIntents());
});

/**
 * GET /act — List available actions.
 */
actRouter.get("/", requireAuth, async (c) => {
  const { dumpRegistry } = await import("./action-registry");
  return c.json(dumpRegistry());
});

/**
 * GET /act/:actionId — Get action definition.
 */
actRouter.get("/:actionId", requireAuth, async (c) => {
  const actionId = c.req.param("actionId");
  if (!actionId) return c.json({ error: "actionId required" }, 400);
  const action = getAction(actionId);
  if (!action) {
    return c.json(fail(actionId, `Unknown action: ${actionId}`), 404);
  }
  return c.json(action);
});

export default actRouter;
