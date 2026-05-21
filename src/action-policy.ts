import type { ActionDef, ObjectScope } from "./action-registry";

export type ActionCategory = "act" | "inspect" | "drill";
export type ActionActorPolicy = "admin" | "authenticated" | "agent_self";

export interface ActionSecurityPolicy {
  /** Minimum actor boundary enforced by /act before execution. */
  actor: ActionActorPolicy;
  /** Argument carrying the target agent id when actor = agent_self. */
  selfArg?: string;
}

const MUTATION_VERBS = new Set([
  "add", "apply", "create", "update", "delete", "remove", "close", "complete",
  "cancel", "start", "stop", "restart", "register", "set",
  "deploy", "retire", "validate", "patch",
  "resolve", "send", "send_message", "invoke", "upsert", "approve", "reject",
  "upsert_user", "remove_user", "add_group", "remove_group",
  "update_status", "update_profile",
  "comment", "update_labels",
  "cleanup_apply", "runtime_cleanup",
]);

const DRILL_VERBS = new Set([
  "stream", "history", "versions", "tree",
]);

const ADMIN_DEFAULT_SCOPES = new Set<ObjectScope>([
  "workflow",
  "element",
  "flow",
  "trigger",
  "case",
  "workitem",
  "role",
  "agent",
  "skill",
  "person",
  "access",
  "connector",
  "adapter",
  "reminder",
  "issue",
  "subscription",
  "audit",
  "retention",
]);

export function classifyAction(actionId: string): ActionCategory {
  const dotIndex = actionId.indexOf(".");
  const verb = dotIndex >= 0 ? actionId.slice(dotIndex + 1) : actionId;
  if (MUTATION_VERBS.has(verb) || verb.split("_").some(segment => MUTATION_VERBS.has(segment))) return "act";
  if (DRILL_VERBS.has(verb)) return "drill";
  return "inspect";
}

export function getActionSecurity(action: ActionDef): ActionSecurityPolicy {
  if (action.security) return action.security;
  if (action.scope === "message") {
    return action.id === "message.read"
      ? { actor: "agent_self", selfArg: "agent_id" }
      : { actor: "authenticated" };
  }
  if (action.scope === "knowledge") return { actor: "authenticated" };
  if (ADMIN_DEFAULT_SCOPES.has(action.scope)) return { actor: "admin" };
  return classifyAction(action.id) === "act" ? { actor: "admin" } : { actor: "authenticated" };
}
