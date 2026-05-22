import type {
  ActionCategory,
  ActionDef,
  ActionImplementation,
  ActionSecurityPolicy,
  ActionSurfaceEntry,
  ValidationResult,
} from "./core-types";
import type { ActionRegistryPort } from "./ports";

export interface ActionRegistryOptions<TScope extends string = string> {
  version: number;
  actions: readonly ActionDef<TScope>[];
  classifyAction?: (actionId: string) => ActionCategory;
  getActionSecurity?: (action: ActionDef<TScope>) => ActionSecurityPolicy;
}

const DEFAULT_MUTATION_VERBS = new Set([
  "add", "apply", "create", "update", "delete", "remove", "close", "complete",
  "cancel", "start", "stop", "restart", "register", "set", "deploy", "undeploy",
  "retire", "validate", "patch", "resolve", "send", "invoke", "upsert",
]);

const DEFAULT_DRILL_VERBS = new Set(["stream", "history", "versions", "tree"]);

export function defaultClassifyAction(actionId: string): ActionCategory {
  const dotIndex = actionId.indexOf(".");
  const verb = dotIndex >= 0 ? actionId.slice(dotIndex + 1) : actionId;
  if (DEFAULT_MUTATION_VERBS.has(verb) || verb.split("_").some(segment => DEFAULT_MUTATION_VERBS.has(segment))) {
    return "act";
  }
  if (DEFAULT_DRILL_VERBS.has(verb)) return "drill";
  return "inspect";
}

export function defaultActionSecurity<TScope extends string>(action: ActionDef<TScope>): ActionSecurityPolicy {
  return defaultClassifyAction(action.id) === "act"
    ? { actor: "admin" }
    : { actor: "authenticated" };
}

function resolveImplementation<TScope extends string>(action: ActionDef<TScope>): ActionImplementation {
  if (action.implementation) return action.implementation;
  if (action.currentEndpoint) return { kind: "endpoint", note: action.currentEndpoint };
  return { kind: "planned", note: "No endpoint, executor, or registered handler has been declared." };
}

export function validateActionArgs<TScope extends string>(
  action: ActionDef<TScope> | undefined,
  actionId: string,
  args: Record<string, unknown>,
): ValidationResult {
  if (!action) {
    return { valid: false, errors: [`Unknown action: ${actionId}`] };
  }

  const errors: string[] = [];
  for (const arg of action.args) {
    const value = args[arg.name];
    if (arg.required && (value === undefined || value === null)) {
      errors.push(`Missing required argument: ${arg.name}`);
      continue;
    }
    if (value === undefined || value === null) continue;

    switch (arg.type) {
      case "string":
        if (typeof value !== "string") errors.push(`Expected string for "${arg.name}", got ${typeof value}`);
        break;
      case "number":
        if (typeof value !== "number" || Number.isNaN(value)) errors.push(`Expected number for "${arg.name}", got ${typeof value}`);
        break;
      case "boolean":
        if (typeof value !== "boolean") errors.push(`Expected boolean for "${arg.name}", got ${typeof value}`);
        break;
      case "object":
        if (typeof value !== "object" || value === null || Array.isArray(value)) errors.push(`Expected object for "${arg.name}"`);
        break;
      case "array":
        if (!Array.isArray(value)) errors.push(`Expected array for "${arg.name}", got ${typeof value}`);
        break;
      case "date":
        if (typeof value !== "string" || Number.isNaN(Date.parse(value))) errors.push(`Expected ISO 8601 date string for "${arg.name}"`);
        break;
    }
  }

  return { valid: errors.length === 0, errors };
}

export function createActionRegistry<TScope extends string = string>(
  options: ActionRegistryOptions<TScope>,
): ActionRegistryPort<TScope> {
  const actions = new Map<string, ActionDef<TScope>>();
  for (const action of options.actions) {
    if (actions.has(action.id)) throw new Error(`Duplicate action id: ${action.id}`);
    actions.set(action.id, action);
  }

  const classify = options.classifyAction ?? defaultClassifyAction;
  const security = options.getActionSecurity ?? defaultActionSecurity;

  return {
    version: options.version,
    get(actionId) {
      return actions.get(actionId);
    },
    list(scope) {
      const all = [...actions.values()];
      return scope ? all.filter(action => action.scope === scope) : all;
    },
    surface(scope) {
      return this.list(scope).map<ActionSurfaceEntry<TScope>>(action => {
        const implementation = resolveImplementation(action);
        return {
          ...action,
          category: classify(action.id),
          implementation,
          security: security(action),
          implemented: implementation.kind !== "planned",
        };
      });
    },
    validate(actionId, args) {
      return validateActionArgs(actions.get(actionId), actionId, args);
    },
  };
}
