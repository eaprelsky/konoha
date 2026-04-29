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
        affordances: {
          actions: [
            {
              id: "workflow.update.current",
              action_id: "workflow.update",
              scope: "workflow",
              label: "Save workflow changes",
              description: "Persist workflow updates.",
              availability: "available",
              suggested_args: { id: "order-flow" },
            },
            {
              id: "element.remove.selection",
              action_id: "element.remove",
              scope: "selection",
              label: "Delete selected element",
              description: "Remove current element.",
              availability: "unavailable",
              reason: "Locked element.",
            },
          ],
        },
      },
    };

    expect(isOperatorStateEnvelope(state)).toBe(true);
    expect(buildOperatorStatePromptBlock(state)).toContain("[Canonical operator state]");
    expect(buildOperatorStatePromptBlock(state)).toContain("\"order-flow\"");
    expect(buildOperatorStatePromptBlock(state)).toContain("\"autonomy\": \"confirm\"");
    expect(buildOperatorStatePromptBlock(state)).toContain("\"risk_level\": \"confirm_required\"");
    expect(buildOperatorStatePromptBlock(state)).toContain("\"risk_level\": \"blocked\"");
    expect(getOperatorStateLabel(state)).toBe("Order Flow (order-flow)");
  });

  test("rejects malformed state", () => {
    expect(isOperatorStateEnvelope({ version: "v0" })).toBe(false);
    expect(buildOperatorStatePromptBlock({ version: "v0" })).toBeNull();
    expect(getOperatorStateLabel({ version: "v0" })).toBe("");
  });
});
