import { describe, it, expect } from "bun:test";
import { checkAutonomy } from "../src/assistant-actions";
import { executeAction } from "../src/act-envelope";
import { registerAllHandlers } from "../src/action-handlers";

describe("canonical action naming", () => {
  it("treats legacy and canonical autonomy keys as the same action", async () => {
    expect(await checkAutonomy("workflow.create")).toBe(await checkAutonomy("workflow_create"));
    expect(await checkAutonomy("issue.create")).toBe(await checkAutonomy("issue_create"));
  });
});

describe("executeAction", () => {
  it("executes workflow.create through the registered canonical handler", async () => {
    registerAllHandlers();

    const id = `test_act_${Date.now().toString(36)}`;
    const result = await executeAction({
      action: "workflow.create",
      category: "act",
      args: {
        id,
        name: "Canonical Spine Test",
        draft: true,
        elements: [
          { id: "e1", type: "event", label: "Start" },
          { id: "f1", type: "function", label: "Work", role: "user" },
        ],
        flow: [["e1", "f1"]],
      },
      meta: {
        session_id: `sess_${id}`,
        agent_chain: "test",
      },
    }, {
      skipAutonomy: true,
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe("workflow.create");
    expect((result.data as Record<string, unknown>).id).toBe(id);
    expect((result.data as Record<string, unknown>).status).toBe("draft");
  });
});
