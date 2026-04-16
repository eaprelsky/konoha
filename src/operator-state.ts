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

export function buildOperatorStatePromptBlock(value: unknown): string | null {
  if (!isOperatorStateEnvelope(value)) return null;
  return `\n\n[Canonical operator state]\n${JSON.stringify(value, null, 2)}`;
}

export function getOperatorStateLabel(value: unknown): string {
  if (!isOperatorStateEnvelope(value)) return "";
  return value.current_view.title || value.current_view.route || value.current_view.id;
}
