import { describe, expect, test } from "bun:test";
import {
  buildSubprocessParentCompletionEffect,
  buildSubprocessSpawnEffect,
  SUBPROCESS_PARENT_COMPLETION_RETRY,
} from "../src/runtime/cases/subprocess-effects";
import { makeCase } from "./factories";

describe("subprocess transition/effect contract", () => {
  test("builds explicit subprocess spawn effect without mutating parent payload", () => {
    const parentCase = makeCase({
      case_id: "case-parent",
      process_id: "workflow-parent",
      subject: "Parent subject",
      payload: { order_id: "ORD-42", nested: { approved: false } },
    });

    const effect = buildSubprocessSpawnEffect({
      parentCase,
      elementId: "delegate",
      element: { label: "Delegate review" },
      childProcessId: "workflow-child",
      parentWorkItemId: "wi-parent",
    });

    expect(effect).toEqual({
      kind: "subprocess.spawn",
      parent_case_id: "case-parent",
      parent_process_id: "workflow-parent",
      parent_subject: "Parent subject",
      parent_work_item_id: "wi-parent",
      element_id: "delegate",
      element_label: "Delegate review",
      child_process_id: "workflow-child",
      child_subject: "Parent subject → Delegate review",
      payload: { order_id: "ORD-42", nested: { approved: false } },
    });

    effect.payload.order_id = "MUTATED";
    expect(parentCase.payload.order_id).toBe("ORD-42");
  });

  test("builds parent completion effect with bounded retry policy", () => {
    const childCase = makeCase({
      case_id: "case-child",
      process_id: "workflow-child",
      parent_case_id: "case-parent",
      parent_work_item_id: "wi-parent",
      payload: { child_result: "accepted" },
    });

    const effect = buildSubprocessParentCompletionEffect(childCase);

    expect(effect).toEqual({
      kind: "subprocess.parent_complete",
      child_case_id: "case-child",
      child_process_id: "workflow-child",
      parent_case_id: "case-parent",
      parent_work_item_id: "wi-parent",
      output: { child_result: "accepted" },
      retry: SUBPROCESS_PARENT_COMPLETION_RETRY,
    });
    expect(effect?.retry).toMatchObject({
      max_attempts: 3,
      initial_delay_ms: 500,
      backoff_multiplier: 2,
    });
  });

  test("does not emit parent completion effect for root cases", () => {
    const rootCase = makeCase({
      case_id: "case-root",
      process_id: "workflow-root",
      parent_work_item_id: undefined,
    });

    expect(buildSubprocessParentCompletionEffect(rootCase)).toBeNull();
  });
});
