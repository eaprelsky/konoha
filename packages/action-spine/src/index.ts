export type {
  ActionActorPolicy,
  ActionCategory,
  ActionDef,
  ActionImplementation,
  ActionImplementationKind,
  ActionSecurityPolicy,
  ActionSurfaceEntry,
  ArgumentDef,
  AutonomyLevel,
  ValidationResult,
} from "./core-types";
export {
  createActionRegistry,
  defaultActionSecurity,
  defaultClassifyAction,
  validateActionArgs,
} from "./registry";
export type {
  ActionAuditPort,
  ActionAuditRecord,
  ActionAuditResult,
  ActionAutonomyPolicyContext,
  ActionAutonomyPolicyPort,
  ActionEnvelopeRequest,
  ActionEnvelopeResult,
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutorPort,
  ActionRegistryPort,
  HttpActionRouteAdapter,
  McpActionBridgeAdapter,
} from "./ports";
export { createMcpActionBridge } from "./bridges/mcp";
export type { McpActionCallPort, McpBridgeOptions, McpTextResult } from "./bridges/mcp";
export { createCliBridge } from "./bridges/cli";
export type { CliBridgeOptions, CliRunResult } from "./bridges/cli";
export { createHttpActionAdapter } from "./bridges/http";
export type { HttpBridgeContext, HttpBridgeOptions } from "./bridges/http";
