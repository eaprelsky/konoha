import { describe, expect, test } from "bun:test";
import { executeActionDirect } from "../src/action-executor";
import { invokeAssistant } from "../src/assistant-invocation";

describe("assistant invocation action", () => {
  test("normalizes Tsunade fixture responses without executing actions", async () => {
    const result = await invokeAssistant({
      assistant_id: "tsunade",
      message: "Create a tiny process",
      conversation_id: "assistant-invocation-fixture",
      persist_history: false,
      execute_actions: false,
      fixture_response: JSON.stringify({
        reply: "Prepared a draft process.",
        create_workflow: {
          id: "fixture-process",
          name: "Fixture process",
          elements: [],
          flow: [],
        },
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      assistant_id: "tsunade",
      conversation_id: "assistant-invocation-fixture",
      stream: false,
      reply: "Prepared a draft process.",
    });
    expect(result.actions_taken).toEqual([]);
    expect(result.action_results).toEqual([]);
  });

  test("executes assistant.invoke through Action Spine in deterministic mode", async () => {
    const result = await executeActionDirect("assistant.invoke", {
      assistant_id: "tsunade",
      message: "Where is the start button?",
      conversation_id: "assistant-invocation-action",
      persist_history: false,
      execute_actions: false,
      fixture_response: JSON.stringify({
        reply: "The start button is highlighted.",
        actions: [
          { type: "highlight", selector: "#btn-start", message: "Start button" },
        ],
      }),
    });

    expect(result?.status).toBe(200);
    expect(result?.data).toMatchObject({
      ok: true,
      assistant_id: "tsunade",
      conversation_id: "assistant-invocation-action",
      reply: "The start button is highlighted.",
    });
    expect((result?.data as any).normalized_response.ui_actions).toEqual([
      { type: "highlight", target: "#btn-start", message: "Start button" },
    ]);
  });

  test("rejects streaming mode because the testbench path is deterministic", async () => {
    const result = await executeActionDirect("assistant.invoke", {
      assistant_id: "tsunade",
      message: "stream please",
      stream: true,
      persist_history: false,
      fixture_response: "{\"reply\":\"ignored\"}",
    });

    expect(result?.status).toBe(400);
    expect((result?.data as any).error).toContain("non-streaming");
  });
});
