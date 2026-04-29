import { z } from "zod";
import {
  ACTION_VERSION,
  classifyAction,
  getAction,
  listActionSurface,
  type ActionCategory,
} from "./action-registry";

export type McpTextResult = { content: { type: "text"; text: string }[] };
export type ActionBridgeApi = <T>(method: string, path: string, body?: unknown, token?: string) => Promise<T>;
export type TokenProvider = () => string | null;

export const actionCategorySchema = z.enum(["act", "inspect", "drill"]);

export const actionCatalogSchema = {
  scope: z.string().optional().describe("Optional action scope filter, e.g. workflow, case, message"),
  category: actionCategorySchema.optional().describe("Optional category filter"),
  include_planned: z.boolean().optional().default(false).describe("Include actions that are not wired yet"),
};

export const actionGetSchema = {
  action: z.string().describe("Canonical action ID, e.g. workflow.create"),
};

export const actionCallSchema = {
  action: z.string().describe("Canonical action ID from konoha_action_catalog"),
  category: actionCategorySchema.optional().describe("Optional category assertion; defaults from the registry"),
  args: z.record(z.string(), z.unknown()).optional().describe("Action arguments matching the registry contract"),
  meta: z.object({
    session_id: z.string().optional(),
    agent_chain: z.string().optional(),
    idempotency_key: z.string().optional(),
  }).optional().describe("Optional action execution metadata"),
};

function jsonResult(value: unknown): McpTextResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function actionCatalog(args: {
  scope?: string;
  category?: ActionCategory;
  include_planned?: boolean;
} = {}): McpTextResult {
  const actions = listActionSurface()
    .filter(action => !args.scope || action.scope === args.scope)
    .filter(action => !args.category || action.category === args.category)
    .filter(action => args.include_planned || action.implemented)
    .map(action => ({
      id: action.id,
      description: action.description,
      scope: action.scope,
      category: action.category,
      args: action.args,
      implemented: action.implemented,
      implementation: action.implementation,
      security: action.security,
      audited: action.audited,
    }));

  return jsonResult({ action_version: ACTION_VERSION, count: actions.length, actions });
}

export function actionGet(actionId: string): McpTextResult {
  const action = getAction(actionId);
  if (!action) return jsonResult({ ok: false, error: `Unknown action: ${actionId}` });
  const [surface] = listActionSurface().filter(entry => entry.id === actionId);
  return jsonResult({ ok: true, action_version: ACTION_VERSION, action: surface });
}

export async function actionCall(
  input: {
    action: string;
    category?: ActionCategory;
    args?: Record<string, unknown>;
    meta?: { session_id?: string; agent_chain?: string; idempotency_key?: string };
  },
  deps: { api: ActionBridgeApi; tokenProvider: TokenProvider; allowAdminFallback?: boolean },
): Promise<McpTextResult> {
  const action = getAction(input.action);
  if (!action) return jsonResult({ ok: false, action: input.action, error: `Unknown action: ${input.action}` });

  const token = deps.tokenProvider();
  if (!token && !deps.allowAdminFallback) {
    return jsonResult({
      ok: false,
      action: input.action,
      error: "konoha_action_call requires an explicit agent token. Run konoha_register first or set KONOHA_AGENT_TOKEN.",
    });
  }

  const envelope = {
    action: input.action,
    category: input.category ?? classifyAction(input.action),
    args: input.args ?? {},
    meta: input.meta,
  };
  const result = await deps.api<unknown>("POST", "/act", envelope, token ?? undefined);
  return jsonResult(result);
}
