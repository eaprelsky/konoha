/**
 * Action Spine package-boundary manifest.
 *
 * This file is intentionally data-only: it can move with a future reusable
 * Action Spine package before Konoha runtime adapters are extracted.
 */

export const ACTION_SPINE_CORE_FILES = [
  "src/action-registry.ts",
  "src/action-policy.ts",
  "src/mcp-action-bridge.ts",
] as const;

export const ACTION_SPINE_KONOHA_ADAPTER_FILES = [
  "src/act-envelope.ts",
  "src/action-executor.ts",
  "src/action-handlers.ts",
  "src/routes/agents.ts",
  "src/routes/roles.ts",
] as const;

export const ACTION_SPINE_PORTS = [
  {
    name: "ActionExecutorPort",
    implemented_by: "src/action-executor.ts",
    purpose: "Execute validated action IDs against Konoha workflow, case, role, agent, reminder, access, and KB services.",
  },
  {
    name: "ActionAuditPort",
    implemented_by: "src/assistant-actions.ts",
    purpose: "Persist audited /act attempts without coupling the core registry to Konoha audit storage.",
  },
  {
    name: "ActionAutonomyPolicyPort",
    implemented_by: "src/assistant-actions.ts",
    purpose: "Resolve confirm/disabled/auto policy at execution time.",
  },
  {
    name: "HttpActionRouteAdapter",
    implemented_by: "src/act-envelope.ts",
    purpose: "Expose the registry and executor through authenticated Hono routes.",
  },
  {
    name: "McpActionBridgeAdapter",
    implemented_by: "src/mcp-action-bridge.ts",
    purpose: "Expose catalog/get/call helpers for MCP tools while calling /act through an injected API function.",
  },
] as const;

export const ACTION_SPINE_FORBIDDEN_CORE_IMPORTS = [
  "workflow-loader",
  "runtime",
  "trigger-resolver",
  "event-manager",
  "normalizer",
  "agent-lifecycle",
  "assistant-actions",
  "people-service",
  "access-control",
  "storage/",
  "routes/",
] as const;
