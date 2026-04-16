import { describe, expect, test } from "bun:test";
import {
  buildOperatorStatePromptBlock,
  getOperatorStateLabel,
  isOperatorStateEnvelope,
  OPERATOR_STATE_VERSION,
} from "../src/operator-state";

describe("operator-state", () => {
  test("accepts valid canonical operator state", () => {
    const state = {
      version: OPERATOR_STATE_VERSION,
      captured_at: "2026-04-16T08:00:00Z",
      current_view: {
        id: "process_editor",
        kind: "process_editor",
        route: "/ui/editor/order-flow",
        title: "Order Flow (order-flow)",
      },
      current_process: {
        workflow: { id: "order-flow", name: "Order Flow" },
      },
    };

    expect(isOperatorStateEnvelope(state)).toBe(true);
    expect(buildOperatorStatePromptBlock(state)).toContain("[Canonical operator state]");
    expect(buildOperatorStatePromptBlock(state)).toContain("\"order-flow\"");
    expect(getOperatorStateLabel(state)).toBe("Order Flow (order-flow)");
  });

  test("rejects malformed state", () => {
    expect(isOperatorStateEnvelope({ version: "v0" })).toBe(false);
    expect(buildOperatorStatePromptBlock({ version: "v0" })).toBeNull();
    expect(getOperatorStateLabel({ version: "v0" })).toBe("");
  });
});
