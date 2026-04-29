import { getAction } from "./action-registry";

export const OPERATOR_STATE_VERSION = "konoha.operator_state/v1";

export interface OperatorStateEnvelope {
  version: typeof OPERATOR_STATE_VERSION;
  captured_at: string;
  current_view: {
    id: string;
    kind: string;
    route: string;
    title: string;
    read_only?: boolean;
    viewport?: {
      width: number;
      height: number;
      device_pixel_ratio: number;
      is_mobile: boolean;
    };
  };
  current_process?: unknown;
}

export interface PromptAffordanceDescriptor {
  id: string;
  action_id: string;
  scope: string;
  label: string;
  description: string;
  availability: "available" | "unavailable";
  reason?: string;
  suggested_args?: Record<string, unknown>;
  registry?: {
    description: string;
    autonomy: string;
    audited: boolean;
    current_endpoint?: string;
    arg_names: string[];
  };
  risk_level?: "routine" | "confirm_required" | "dangerous" | "blocked";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isOperatorStateEnvelope(value: unknown): value is OperatorStateEnvelope {
  if (!isRecord(value)) return false;
  if (value.version !== OPERATOR_STATE_VERSION) return false;
  if (typeof value.captured_at !== "string") return false;
  if (!isRecord(value.current_view)) return false;
  if (typeof value.current_view.id !== "string") return false;
  if (typeof value.current_view.kind !== "string") return false;
  if (typeof value.current_view.route !== "string") return false;
  if (typeof value.current_view.title !== "string") return false;
  return true;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isAffordanceDescriptor(value: unknown): value is PromptAffordanceDescriptor {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.action_id === "string"
    && typeof value.scope === "string"
    && typeof value.label === "string"
    && typeof value.description === "string"
    && (value.availability === "available" || value.availability === "unavailable");
}

function deriveRiskLevel(autonomy: string, availability: "available" | "unavailable"): PromptAffordanceDescriptor["risk_level"] {
  if (availability === "unavailable") return "blocked";
  if (autonomy === "auto") return "routine";
  if (autonomy === "confirm") return "confirm_required";
  return "dangerous";
}

function enrichAffordancesForPrompt(state: OperatorStateEnvelope): OperatorStateEnvelope {
  const cloned = clone(state) as OperatorStateEnvelope;
  const currentProcess = isRecord(cloned.current_process) ? cloned.current_process : null;
  const affordanceContainer = currentProcess && isRecord(currentProcess.affordances)
    ? currentProcess.affordances
    : null;
  const affordances = affordanceContainer && Array.isArray(affordanceContainer.actions)
    ? affordanceContainer.actions
    : null;

  if (!affordances) return cloned;
  affordanceContainer!.actions = affordances.map((item: unknown) => {
    if (!isAffordanceDescriptor(item)) return item;
    const action = getAction(item.action_id);
    if (!action) {
      return {
        ...item,
        risk_level: item.availability === "available" ? "dangerous" : "blocked",
      };
    }
    return {
      ...item,
      registry: {
        description: action.description,
        autonomy: action.autonomy,
        audited: action.audited,
        ...(action.currentEndpoint ? { current_endpoint: action.currentEndpoint } : {}),
        arg_names: action.args.map((arg) => arg.name),
      },
      risk_level: deriveRiskLevel(action.autonomy, item.availability),
    };
  });

  return cloned;
}

export function buildOperatorStatePromptBlock(value: unknown): string | null {
  if (!isOperatorStateEnvelope(value)) return null;
  return `\n\n[Canonical operator state]\n${JSON.stringify(enrichAffordancesForPrompt(value), null, 2)}`;
}

export function getOperatorStateLabel(value: unknown): string {
  if (!isOperatorStateEnvelope(value)) return "";
  return value.current_view.title || value.current_view.route || value.current_view.id;
}
