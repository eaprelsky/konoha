import type {
  ActionCategory,
  ActionDef,
  ActionSurfaceEntry,
  AutonomyLevel,
  ValidationResult,
} from "./core-types";

export interface ActionExecutionRequest {
  action: string;
  args: Record<string, unknown>;
  meta?: {
    session_id?: string;
    agent_chain?: string;
    idempotency_key?: string;
  };
}

export interface ActionExecutionResult {
  status: number;
  data: unknown;
}

export interface ActionExecutorPort {
  execute(request: ActionExecutionRequest): Promise<ActionExecutionResult | null>;
}

export type ActionAuditResult = "ok" | "blocked" | "error" | "requires_confirm";

export interface ActionAuditRecord {
  timestamp: string;
  session_id: string;
  action_type: string;
  parameters: string;
  result: ActionAuditResult;
  agent_chain: string;
  args_summary?: string;
  error?: string;
}

export interface ActionAuditPort {
  record(entry: ActionAuditRecord): Promise<{ audit_id: string | null }>;
}

export interface ActionAutonomyPolicyContext {
  actor?: string;
  session_id?: string;
  agent_chain?: string;
}

export interface ActionAutonomyPolicyPort {
  resolve(action: ActionDef, context: ActionAutonomyPolicyContext): Promise<AutonomyLevel>;
}

export interface ActionRegistryPort<TScope extends string = string> {
  readonly version: number;
  get(actionId: string): ActionDef<TScope> | undefined;
  list(scope?: TScope): ActionDef<TScope>[];
  surface(scope?: TScope): ActionSurfaceEntry<TScope>[];
  validate(actionId: string, args: Record<string, unknown>): ValidationResult;
}

export interface ActionEnvelopeRequest {
  action: string;
  category: ActionCategory;
  args: Record<string, unknown>;
  meta?: ActionExecutionRequest["meta"];
}

export interface ActionEnvelopeResult {
  ok: boolean;
  action: string;
  action_version: number;
  status?: number;
  data?: unknown;
  error?: string;
  requires_confirm?: boolean;
}

export interface HttpActionRouteAdapter {
  execute(envelope: ActionEnvelopeRequest, context: {
    auth_header?: string;
    session_id?: string;
    agent_chain?: string;
    skip_autonomy?: boolean;
  }): Promise<ActionEnvelopeResult>;
}

export interface McpActionBridgeAdapter {
  catalog(args?: {
    scope?: string;
    category?: ActionCategory;
    include_planned?: boolean;
  }): Promise<unknown> | unknown;
  get(actionId: string): Promise<unknown> | unknown;
  call(input: ActionEnvelopeRequest): Promise<unknown>;
}
