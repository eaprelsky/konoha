export type ActionCategory = "act" | "inspect" | "drill";
export type ActionActorPolicy = "admin" | "authenticated" | "agent_self";
export type AutonomyLevel = "auto" | "confirm" | "disabled";
export type ActionImplementationKind = "direct" | "endpoint" | "registered-handler" | "planned";

export interface ActionSecurityPolicy {
  /** Minimum actor boundary enforced by the host before execution. */
  actor: ActionActorPolicy;
  /** Argument carrying the target agent id when actor = agent_self. */
  selfArg?: string;
}

export interface ActionImplementation {
  kind: ActionImplementationKind;
  /** Short migration note for planned/legacy implementations. */
  note?: string;
}

export interface ArgumentDef {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "date";
  required: boolean;
  description: string;
}

export interface ActionDef<TScope extends string = string> {
  /** Unique dotted name: `{scope}.{verb}` */
  id: string;
  /** Human-readable summary */
  description: string;
  /** Host-owned object scope this action belongs to */
  scope: TScope;
  /** Argument contract */
  args: ArgumentDef[];
  /** Current HTTP method + path that handles this action (for migration tracking) */
  currentEndpoint?: string;
  /** Explicit implementation metadata when currentEndpoint is not sufficient. */
  implementation?: ActionImplementation;
  /** Actor policy enforced by the host. If omitted, inferred by host policy. */
  security?: ActionSecurityPolicy;
  /** Default autonomy level */
  autonomy: AutonomyLevel;
  /** Whether this action writes to the audit log */
  audited: boolean;
}

export interface ActionSurfaceEntry<TScope extends string = string> extends ActionDef<TScope> {
  category: ActionCategory;
  implementation: ActionImplementation;
  security: ActionSecurityPolicy;
  implemented: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}
