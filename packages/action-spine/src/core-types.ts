export type ActionCategory = "act" | "inspect" | "drill";
export type ActionActorPolicy = "admin" | "authenticated" | "agent_self";
export type AutonomyLevel = "auto" | "confirm" | "disabled";
export type ActionImplementationKind = "direct" | "endpoint" | "registered-handler" | "planned";

export interface ActionSecurityPolicy {
  actor: ActionActorPolicy;
  selfArg?: string;
}

export interface ActionImplementation {
  kind: ActionImplementationKind;
  note?: string;
}

export interface ArgumentDef {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "date";
  required: boolean;
  description: string;
}

export interface ActionDef<TScope extends string = string> {
  id: string;
  description: string;
  scope: TScope;
  args: ArgumentDef[];
  currentEndpoint?: string;
  implementation?: ActionImplementation;
  security?: ActionSecurityPolicy;
  autonomy: AutonomyLevel;
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
