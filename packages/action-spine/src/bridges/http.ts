import type {
  ActionAuditPort,
  ActionAutonomyPolicyPort,
  ActionEnvelopeRequest,
  ActionEnvelopeResult,
  ActionExecutorPort,
  ActionRegistryPort,
} from "../ports";

export interface HttpBridgeContext {
  actor?: string;
  session_id?: string;
  agent_chain?: string;
  skip_autonomy?: boolean;
}

export interface HttpBridgeOptions<TScope extends string = string> {
  registry: ActionRegistryPort<TScope>;
  executor: ActionExecutorPort;
  audit?: ActionAuditPort;
  autonomy?: ActionAutonomyPolicyPort;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createHttpActionAdapter<TScope extends string = string>(
  options: HttpBridgeOptions<TScope>,
): { execute(envelope: ActionEnvelopeRequest, context?: HttpBridgeContext): Promise<ActionEnvelopeResult> } {
  return {
    async execute(envelope, context = {}) {
      const action = options.registry.get(envelope.action);
      if (!action) {
        return { ok: false, action: envelope.action, action_version: options.registry.version, status: 404, error: `Unknown action: ${envelope.action}` };
      }

      const validation = options.registry.validate(envelope.action, envelope.args ?? {});
      if (!validation.valid) {
        return { ok: false, action: envelope.action, action_version: options.registry.version, status: 400, error: `Validation: ${validation.errors.join("; ")}` };
      }

      if (options.autonomy && !context.skip_autonomy) {
        const autonomy = await options.autonomy.resolve(action, {
          actor: context.actor,
          session_id: context.session_id,
          agent_chain: context.agent_chain,
        });
        if (autonomy === "disabled" || autonomy === "confirm") {
          const result: ActionEnvelopeResult = {
            ok: false,
            action: envelope.action,
            action_version: options.registry.version,
            status: 409,
            requires_confirm: autonomy === "confirm",
            error: autonomy === "disabled" ? "Action disabled by autonomy policy" : "Action requires confirmation",
          };
          await options.audit?.record({
            timestamp: nowIso(),
            session_id: context.session_id ?? "unknown",
            action_type: envelope.action,
            parameters: JSON.stringify(envelope.args ?? {}),
            result: autonomy === "confirm" ? "requires_confirm" : "blocked",
            agent_chain: context.agent_chain ?? "unknown",
            error: result.error,
          });
          return result;
        }
      }

      const executed = await options.executor.execute({
        action: envelope.action,
        args: envelope.args ?? {},
        meta: envelope.meta,
      });
      if (!executed) {
        return { ok: false, action: envelope.action, action_version: options.registry.version, status: 501, error: "No injected executor handled this action" };
      }

      const ok = executed.status >= 200 && executed.status < 300;
      await options.audit?.record({
        timestamp: nowIso(),
        session_id: context.session_id ?? envelope.meta?.session_id ?? "unknown",
        action_type: envelope.action,
        parameters: JSON.stringify(envelope.args ?? {}),
        result: ok ? "ok" : "error",
        agent_chain: context.agent_chain ?? envelope.meta?.agent_chain ?? "unknown",
        error: ok ? undefined : JSON.stringify(executed.data),
      });

      return {
        ok,
        action: envelope.action,
        action_version: options.registry.version,
        status: executed.status,
        data: ok ? executed.data : undefined,
        error: ok ? undefined : JSON.stringify(executed.data),
      };
    },
  };
}
