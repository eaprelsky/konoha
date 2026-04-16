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
  getAction,
  isValidAction,
  type ActionDef,
  type AutonomyLevel,
} from "./action-registry";
import { auditLog, checkAutonomy } from "./assistant-actions";

// ── Direct action handlers (Phase 2 of #527) ────────────────────────────────
// Maps action IDs to direct function implementations, bypassing HTTP roundtrip.
// Registered via registerHandler() at startup.

type ActionHandler = (args: Record<string, unknown>) => Promise<unknown>;

const ACTION_HANDLERS = new Map<string, ActionHandler>();

/**
 * Register a direct handler for an action ID.
 * When executeAction() is called for this action, the handler runs directly
 * instead of routing through HTTP. Validates that the action exists in the registry.
 */
export function registerHandler(actionId: string, handler: ActionHandler): void {
  if (!isValidAction(actionId)) {
    throw new Error(`Cannot register handler for unknown action: ${actionId}`);
  }
  ACTION_HANDLERS.set(actionId, handler);
}

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

  // Validate required arguments
  const def = getAction(envelope.action)!;
  for (const arg of def.args) {
    if (arg.required && !(arg.name in envelope.args)) {
      errors.push({ field: `args.${arg.name}`, message: `Required argument missing: ${arg.name}` });
    }
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

function ok(action: string, data: unknown): ActResult {
  return { ok: true, action, data, action_version: 1 };
}

function fail(action: string, error: string): ActResult {
  return { ok: false, action, error, action_version: 1 };
}

function needConfirm(action: string): ActResult {
  return { ok: false, action, requires_confirm: true, action_version: 1 };
}

// ── Programmatic action execution (#527) ─────────────────────────────────────
// Server-side callers (assistant, event handlers) use executeAction() instead
// of calling handler functions directly. This ensures every action passes
// through validate → autonomy → audit, same as the HTTP /act endpoint.

/**
 * Execute an action programmatically through the canonical spine.
 *
 * Flow: validate → autonomy check → direct handler (if registered) or
 * HTTP fallback → audit log → ActResult.
 *
 * This is the single entry point for ALL server-side action execution.
 * Assistant flows, event handlers, and internal code should call this
 * instead of invoking handler functions directly.
 */
export async function executeAction(
  envelope: ActEnvelope,
  opts?: { agentChain?: string },
): Promise<ActResult> {
  const agentChain = opts?.agentChain ?? envelope.meta?.agent_chain ?? "internal";

  // 1. Validate against registry
  const errors = validateEnvelope(envelope);
  if (errors.length > 0) {
    return fail(envelope.action, `Validation: ${errors.map(e => e.message).join("; ")}`);
  }

  const action = getAction(envelope.action)!;
  const category = classifyAction(envelope.action);
  const sessionId = envelope.meta?.session_id ?? crypto.randomUUID();

  // 2. Autonomy check (for act/mutation actions)
  if (category === "act") {
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

  // 3. Try direct handler first (Phase 2 of #527)
  const handler = ACTION_HANDLERS.get(envelope.action);
  if (handler) {
    try {
      const data = await handler(envelope.args);
      if (category === "act" && action.audited) {
        await auditLog({
          timestamp: new Date().toISOString(),
          session_id: sessionId,
          action_type: envelope.action,
          parameters: JSON.stringify(envelope.args),
          result: "ok",
          agent_chain: agentChain,
        });
      }
      return ok(envelope.action, data);
    } catch (e: any) {
      if (category === "act" && action.audited) {
        await auditLog({
          timestamp: new Date().toISOString(),
          session_id: sessionId,
          action_type: envelope.action,
          parameters: JSON.stringify(envelope.args),
          result: "error",
          agent_chain: agentChain,
          error: e.message,
        });
      }
      return fail(envelope.action, e.message);
    }
  }

  // 4. Fallback: try HTTP endpoint (Phase 1 legacy)
  const endpoint = resolveEndpoint(action, envelope.args);
  if (!endpoint) {
    return fail(envelope.action, `No handler or endpoint for action ${envelope.action}`);
  }

  try {
    const baseUrl = `http://127.0.0.1:${process.env.KONOHA_PORT || 3200}`;
    const url = `${baseUrl}${endpoint.path}`;
    const fetchOpts: RequestInit = {
      method: endpoint.method,
      headers: { "Content-Type": "application/json" },
    };
    if (endpoint.body && ["POST", "PUT", "PATCH"].includes(endpoint.method)) {
      fetchOpts.body = JSON.stringify(endpoint.body);
    }

    const response = await fetch(url, fetchOpts);
    const data = await response.json();

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

    return ok(envelope.action, data);
  } catch (e: any) {
    return fail(envelope.action, `Internal routing error: ${e.message}`);
  }
}

// ── Internal HTTP routing (Phase 1 legacy) ───────────────────────────────────
// Used by the HTTP /act endpoint when no direct handler is registered.

import { redis } from "./redis";

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
  const agentChain = envelope.meta?.agent_chain ?? "api";

  // Delegate to canonical executeAction() — single code path (#527)
  const result = await executeAction(envelope, { agentChain });

  // Map ActResult to HTTP response
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
    return c.json(fail(intent, `Unknown intent: ${intent}. Available: ${listIntents().map(i => i.id).join(", ")}`), 404);
  }
  return c.json({ ok: true, action: `intent.${intent}`, data: plan, action_version: 1 });
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
  const action = getAction(actionId);
  if (!action) {
    return c.json(fail(actionId, `Unknown action: ${actionId}`), 404);
  }
  return c.json(action);
});

export default actRouter;
