export type ActionCategory = "act" | "inspect" | "drill";
export type ActionStepStatus = "passed" | "failed" | "error";
export type ActionScenarioStatus = "passed" | "failed" | "error";

export interface ActEnvelope {
  action: string;
  category?: ActionCategory;
  args?: Record<string, unknown>;
  meta?: {
    session_id?: string;
    agent_chain?: string;
    idempotency_key?: string;
  };
}

export interface ActionReceipt {
  ok?: boolean;
  action?: string;
  data?: unknown;
  error?: string;
  status?: number;
  requires_confirm?: boolean;
  action_version?: number;
  [key: string]: unknown;
}

export interface ActionReceiptAssertion {
  path: string;
  equals?: unknown;
  exists?: boolean;
}

export interface ActionScenarioStep {
  name?: string;
  envelope: ActEnvelope;
  assertions?: ActionReceiptAssertion[];
}

export interface ActionScenario {
  name: string;
  steps: ActionScenarioStep[];
  stop_on_failure?: boolean;
}

export interface ActionStepResult {
  name: string;
  action: string;
  status: ActionStepStatus;
  duration_ms: number;
  receipt?: ActionReceipt;
  assertions: ActionAssertionResult[];
  error?: string;
}

export interface ActionAssertionResult {
  path: string;
  ok: boolean;
  expected?: unknown;
  actual?: unknown;
  error?: string;
}

export interface ActionScenarioResult {
  ok: boolean;
  name: string;
  status: ActionScenarioStatus;
  started_at: string;
  duration_ms: number;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  steps: ActionStepResult[];
}

export interface RunActionScenarioInput {
  base_url: string;
  token?: string;
  scenario: ActionScenario;
  fetch_impl?: typeof fetch;
}

export async function runActionScenario(input: RunActionScenarioInput): Promise<ActionScenarioResult> {
  validateRunInput(input);

  const fetchImpl = input.fetch_impl ?? fetch;
  const startedAt = new Date().toISOString();
  const runStart = performance.now();
  const steps: ActionStepResult[] = [];
  const stopOnFailure = input.scenario.stop_on_failure !== false;

  for (const [index, step] of input.scenario.steps.entries()) {
    const result = await runActionStep({
      base_url: input.base_url,
      token: input.token,
      step,
      index,
      fetch_impl: fetchImpl,
    });
    steps.push(result);

    if (stopOnFailure && result.status !== "passed") break;
  }

  const passed = steps.filter(step => step.status === "passed").length;
  const failed = steps.filter(step => step.status === "failed").length;
  const errors = steps.filter(step => step.status === "error").length;
  const status: ActionScenarioStatus = errors > 0 ? "error" : failed > 0 ? "failed" : "passed";

  return {
    ok: status === "passed",
    name: input.scenario.name,
    status,
    started_at: startedAt,
    duration_ms: elapsedMs(runStart),
    total: steps.length,
    passed,
    failed,
    errors,
    steps,
  };
}

async function runActionStep(input: {
  base_url: string;
  token?: string;
  step: ActionScenarioStep;
  index: number;
  fetch_impl: typeof fetch;
}): Promise<ActionStepResult> {
  const started = performance.now();
  const action = input.step.envelope.action;
  const name = input.step.name ?? `${input.index + 1}. ${action}`;

  try {
    const receipt = await postActEnvelope(input);
    const assertions = evaluateAssertions(receipt, [
      { path: "action", equals: action },
      ...(input.step.assertions ?? []),
    ]);
    const status = assertions.every(assertion => assertion.ok) ? "passed" : "failed";

    return {
      name,
      action,
      status,
      duration_ms: elapsedMs(started),
      receipt,
      assertions,
    };
  } catch (e: any) {
    return {
      name,
      action,
      status: "error",
      duration_ms: elapsedMs(started),
      assertions: [],
      error: e.message,
    };
  }
}

async function postActEnvelope(input: {
  base_url: string;
  token?: string;
  step: ActionScenarioStep;
  fetch_impl: typeof fetch;
}): Promise<ActionReceipt> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.token) headers.Authorization = `Bearer ${input.token}`;

  const response = await input.fetch_impl(`${trimSlash(input.base_url)}/act`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...input.step.envelope,
      args: input.step.envelope.args ?? {},
    }),
  });

  const receipt = await response.json().catch(() => ({
    ok: false,
    error: `Non-JSON /act response (${response.status})`,
    status: response.status,
  })) as ActionReceipt;

  if (receipt.status === undefined) receipt.status = response.status;
  if (!response.ok && receipt.error === undefined) {
    receipt.error = `HTTP ${response.status}`;
  }
  return receipt;
}

export function evaluateAssertions(
  receipt: ActionReceipt,
  assertions: ActionReceiptAssertion[],
): ActionAssertionResult[] {
  return assertions.map(assertion => {
    const actual = getPath(receipt, assertion.path);
    if (assertion.exists !== undefined) {
      const exists = actual !== undefined;
      return {
        path: assertion.path,
        ok: exists === assertion.exists,
        expected: assertion.exists,
        actual: exists,
      };
    }
    if ("equals" in assertion) {
      return {
        path: assertion.path,
        ok: deepEqual(actual, assertion.equals),
        expected: assertion.equals,
        actual,
      };
    }
    return {
      path: assertion.path,
      ok: false,
      error: "assertion must define equals or exists",
    };
  });
}

function validateRunInput(input: RunActionScenarioInput): void {
  if (!input.base_url || typeof input.base_url !== "string") {
    throw new Error("base_url required");
  }
  if (!input.scenario || typeof input.scenario !== "object") {
    throw new Error("scenario required");
  }
  if (!input.scenario.name || typeof input.scenario.name !== "string") {
    throw new Error("scenario.name required");
  }
  if (!Array.isArray(input.scenario.steps) || input.scenario.steps.length === 0) {
    throw new Error("scenario.steps must be a non-empty array");
  }
  for (const [index, step] of input.scenario.steps.entries()) {
    if (!step?.envelope?.action || typeof step.envelope.action !== "string") {
      throw new Error(`scenario.steps[${index}].envelope.action required`);
    }
  }
}

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce((current: unknown, part) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function elapsedMs(started: number): number {
  return Math.round(performance.now() - started);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
