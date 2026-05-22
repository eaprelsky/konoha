import type { ActionCategory } from "../core-types";
import type { ActionEnvelopeRequest, ActionRegistryPort, McpActionBridgeAdapter } from "../ports";

export type McpTextResult = { content: { type: "text"; text: string }[] };
export type McpActionCallPort = (input: ActionEnvelopeRequest) => Promise<unknown> | unknown;

export interface McpBridgeOptions<TScope extends string = string> {
  registry: ActionRegistryPort<TScope>;
  call: McpActionCallPort;
}

function jsonResult(value: unknown): McpTextResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function createMcpActionBridge<TScope extends string = string>(
  options: McpBridgeOptions<TScope>,
): McpActionBridgeAdapter {
  return {
    catalog(args: { scope?: string; category?: ActionCategory; include_planned?: boolean } = {}) {
      const actions = options.registry.surface(args.scope as TScope | undefined)
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
      return jsonResult({ action_version: options.registry.version, count: actions.length, actions });
    },
    get(actionId: string) {
      const [surface] = options.registry.surface().filter(action => action.id === actionId);
      if (!surface) return jsonResult({ ok: false, error: `Unknown action: ${actionId}` });
      return jsonResult({ ok: true, action_version: options.registry.version, action: surface });
    },
    async call(input: ActionEnvelopeRequest) {
      const validation = options.registry.validate(input.action, input.args ?? {});
      if (!validation.valid) {
        return jsonResult({
          ok: false,
          action: input.action,
          action_version: options.registry.version,
          error: `Validation: ${validation.errors.join("; ")}`,
        });
      }
      return jsonResult(await options.call(input));
    },
  };
}
