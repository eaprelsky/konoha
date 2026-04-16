/**
 * act-envelope.ts — Unified action envelope for system operations (#500, #527)
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
 *
 * #527 adds programmatic executeAction() so server-side callers (assistant,
 * event handlers) route through the same validate → autonomy → audit pipeline
 * as the HTTP /act endpoint. No parallel mutation contracts.
 */

import { Hono } from "hono";
import type { HonoEnv } from "./types";
import { requireAuth } from "./middleware/auth";
import {
  ACTION_VERSION,
  getAction,
  isValidAction,
  type ActionDef,
} from "./action-registry";
import { auditLog, checkAutonomy } from "./assistant-actions";

// ── Envelope types ───────────────────────────────────────────────────────────

export type ActCategory = "act" | "inspect" | "drill";

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

// ── Category classification ──────────────────────────────────────────────────

const MUTATION_VERBS = new Set([
  "create", "update", "delete", "remove", "close", "complete",
  "cancel", "start", "stop", "restart", "register", "set",
  "resolve", "send",
]);

const DRILL_VERBS = new Set([
  "stream", "history", "versions", "tree",
]);

/**
 * Classify an action into act/inspect/drill based on its verb.
 */
export function classifyAction(actionId: string): ActCategory {
  const verb = actionId.split(".")[1] ?? "";
  if (MUTATION_VERBS.has(verb)) return "act";
  if (DRILL_VERBS.has(verb)) return "drill";
  return "inspect";
}

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

  const def = getAction(envelope.action)!;
  for (const arg of def.args) {
    if (arg.required && !(arg.name in envelope.args)) {
      errors.push({ field: `args.${arg.name}`, message: `Required argument missing: ${arg.name}` });
    }
  }

  const expectedCategory = classifyAction(envelope.action);
  if (envelope.category && envelope.category !== expectedCategory) {
    errors.push({
      field: "category",
      message: `Action ${envelope.action} is category '${expectedCategory}', not '${envelope.category}'`,
    });
  }

  return errors;
}

// ── Response helpers ─────────────────────────────────────────────────────────

function ok(action: string, data: unknown): ActResult {
  return { ok: true, action, data, action_version: ACTION_VERSION };
}

function fail(action: string, error: string): ActResult {
  return { ok: false, action, error, action_version: ACTION_VERSION };
}

function needConfirm(action: string): ActResult {
  return { ok: false, action, requires_confirm: true, action_version: ACTION_VERSION };
}

// ── Direct action handlers (Phase 2 of #527) ────────────────────────────────

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

    return ok(action.id, data);
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

/**
 * Execute an action programmatically through the canonical spine.
 *
 * Flow: validate → autonomy check → direct handler (if registered) or
 * HTTP fallback → audit log → ActResult.
 */
export async function executeAction(
  envelope: ActEnvelope,
  opts: ExecuteActionOptions = {},
): Promise<ActResult> {
  const errors = validateEnvelope(envelope);
  if (errors.length > 0) {
    return fail(envelope.action ?? "unknown", `Validation: ${errors.map((e) => e.message).join("; ")}`);
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

  const direct = await executeRegisteredHandler(action, envelope.args, ctx);
  if (direct) return direct;

  const endpoint = resolveEndpoint(action, envelope.args);
  if (!endpoint) {
    return ok(envelope.action, {
      note: "Action registered but not yet wired to a direct handler",
      definition: action,
    });
  }

  try {
    const baseUrl = `http://127.0.0.1:${process.env.KONOHA_PORT || 3200}`;
    const url = `${baseUrl}${endpoint.path}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.authHeader) headers.Authorization = opts.authHeader;

    const fetchOpts: RequestInit = {
      method: endpoint.method,
      headers,
    };
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
    return ok(envelope.action, data);
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

  let path = pathTemplate;
  const pathParams = pathTemplate.match(/:(\w+)/g) ?? [];
  for (const param of pathParams) {
    const key = param.slice(1);
    const argKey = key === "id" ? findIdArg(action, args) : key;
    const value = args[argKey];
    if (value == null) return null;
    path = path.replace(param, String(value));
  }

  const pathKeys = new Set(pathParams.map((param) => {
    const key = param.slice(1);
    return key === "id" ? findIdArg(action, args) : key;
  }));

  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!pathKeys.has(key)) body[key] = value;
  }

  return { method, path, body: Object.keys(body).length > 0 ? body : undefined };
}

function findIdArg(action: ActionDef, args: Record<string, unknown>): string {
  const idArg = action.args.find((arg) =>
    arg.name.endsWith("_id") || arg.name === "id" || arg.name === "process_id"
  );
  if (idArg && args[idArg.name] != null) return idArg.name;
  return "id";
}

// ── Route handler ────────────────────────────────────────────────────────────

export const actRouter = new Hono<HonoEnv>();

actRouter.post("/", requireAuth, async (c) => {
  const envelope = await c.req.json<ActEnvelope>();
  const result = await executeAction(envelope, {
    agent_chain: envelope.meta?.agent_chain ?? "api",
    authHeader: c.req.header("Authorization"),
  });

  if (!result.ok && result.requires_confirm) {
    return c.json(result, 202);
  }
  if (!result.ok) {
    return c.json(result, result.error?.startsWith("Validation") ? 400 : 500);
  }
  return c.json(result, 200);
});

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
    return c.json(fail(intent, `Unknown intent: ${intent}. Available: ${listIntents().map((i) => i.id).join(", ")}`), 404);
  }
  return c.json({ ok: true, action: `intent.${intent}`, data: plan, action_version: ACTION_VERSION });
});

actRouter.get("/intent", requireAuth, async (c) => {
  const { listIntents } = await import("./intent-decomposer");
  return c.json(listIntents());
});

actRouter.get("/", requireAuth, async (c) => {
  const { dumpRegistry } = await import("./action-registry");
  return c.json(dumpRegistry());
});

actRouter.get("/:actionId", requireAuth, async (c) => {
  const actionId = c.req.param("actionId") ?? "";
  const action = getAction(actionId);
  if (!action) {
    return c.json(fail(actionId, `Unknown action: ${actionId}`), 404);
  }
  return c.json(action);
});

export default actRouter;
