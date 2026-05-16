import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.restore();

const state = {
  completed: [] as Array<{ work_item_id: string; output: Record<string, unknown> }>,
  updated: [] as Array<{ work_item_id: string; patch: Record<string, unknown> }>,
  audit: [] as Array<Record<string, unknown>>,
};

mock.module("../src/runtime/reminders", () => ({
  async createReminder() {
    return {};
  },
}));

mock.module("../src/runtime/work-items", () => ({
  async completeWorkItem(work_item_id: string, output: Record<string, unknown>) {
    state.completed.push({ work_item_id, output });
    return { workItem: { work_item_id, status: "done", output }, case: null };
  },
  async updateWorkItem(work_item_id: string, patch: Record<string, unknown>) {
    state.updated.push({ work_item_id, patch });
    return { work_item_id, ...patch };
  },
}));

mock.module("../src/action-registry", () => ({
  classifyAction() {
    return "act";
  },
}));

mock.module("../src/act-envelope", () => ({
  async executeAction(envelope: { action: string; args: Record<string, unknown>; meta?: Record<string, unknown> }) {
    state.audit.push({
      action_type: envelope.action,
      result: "ok",
      agent_chain: envelope.meta?.agent_chain,
    });
    if (envelope.action === "issue.update_labels") {
      return {
        ok: true,
        action: envelope.action,
        status: 200,
        data: { args: envelope.args },
        action_version: 1,
      };
    }
    if (envelope.action !== "issue.close") {
      return { ok: false, action: envelope.action, status: 404, error: "unsupported", action_version: 1 };
    }
    return {
      ok: true,
      action: envelope.action,
      status: 200,
      data: {
        dry_run: true,
        command: ["gh", "issue", "close", String(envelope.args.issue_number), "--repo", "eaprelsky/konoha"],
      },
      action_version: 1,
    };
  },
}));

const { executeSystemFunction } = await import("../src/system-agent");

beforeEach(() => {
  state.completed = [];
  state.updated = [];
  state.audit = [];
});

describe("system-agent Action Spine bindings", () => {
  test("uses binding_id scoped action_args for repeated operations", async () => {
    await executeSystemFunction({
      label: "Update labels twice",
      work_item_id: "wi-action-spine-repeated-operation",
      case_id: "case-system-action-spine",
      process_id: "developer-reviewer-github-issue",
      element_id: "f_select_next_lane",
      docIds: [],
      systems: [
        { binding_id: "f_close_issue.issue.update_labels", connector: "action_spine", operation: "issue.update_labels" },
        { binding_id: "f_select_next_lane.issue.update_labels", connector: "action_spine", operation: "issue.update_labels" },
      ],
      payload: {
        action_args: {
          "issue.update_labels": { issue_number: 999, add_labels: ["wrong-operation-scope"] },
          "f_close_issue.issue.update_labels": { issue_number: 803, add_labels: ["state:closed"] },
          "f_select_next_lane.issue.update_labels": { issue_number: 804, add_labels: ["state:ready-for-dev"] },
        },
      },
    });

    expect(state.updated).toHaveLength(0);
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0].output).toMatchObject({
      system: "action_spine",
      receipts: [
        {
          action: "issue.update_labels",
          binding_scope: "f_close_issue.issue.update_labels",
          data: { args: { issue_number: 803, add_labels: ["state:closed"] } },
        },
        {
          action: "issue.update_labels",
          binding_scope: "f_select_next_lane.issue.update_labels",
          data: { args: { issue_number: 804, add_labels: ["state:ready-for-dev"] } },
        },
      ],
    });
  });

  test("executes action_spine systems with payload action_args and stores audited receipts", async () => {
    await executeSystemFunction({
      label: "Close reviewed GitHub issue",
      work_item_id: "wi-action-spine",
      case_id: "case-system-action-spine",
      process_id: "developer-reviewer-github-issue",
      element_id: "f_close_issue",
      docIds: [],
      systems: [{ binding_id: "f_close_issue.issue.close", connector: "action_spine", operation: "issue.close" }],
      payload: {
        closure_allowed: true,
        action_args: {
          "f_close_issue.issue.close": { issue_number: 803, dry_run: true },
        },
      },
    });

    expect(state.updated).toHaveLength(0);
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0].output).toMatchObject({
      system: "action_spine",
      receipts: [{
        action: "issue.close",
        binding_scope: "f_close_issue.issue.close",
        status: 200,
        data: {
          dry_run: true,
          command: ["gh", "issue", "close", "803", "--repo", "eaprelsky/konoha"],
        },
      }],
    });
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]).toMatchObject({
      action_type: "issue.close",
      result: "ok",
      agent_chain: "workflow:system-agent",
    });
  });

  test("fails closed when action_args are missing", async () => {
    await executeSystemFunction({
      label: "Close reviewed GitHub issue",
      work_item_id: "wi-action-spine-missing",
      case_id: "case-system-action-spine",
      process_id: "developer-reviewer-github-issue",
      element_id: "f_close_issue",
      docIds: [],
      systems: [{ binding_id: "f_close_issue.issue.close", connector: "action_spine", operation: "issue.close" }],
      payload: { closure_allowed: true },
    });

    expect(state.completed).toHaveLength(0);
    expect(state.updated).toHaveLength(1);
    expect(state.updated[0].patch).toMatchObject({
      status: "error",
      output: {
        system: "action_spine-error",
        action: "issue.close",
        binding_scope: "f_close_issue.issue.close",
      },
    });
  });

  test("fails closed before issue.close when closure_allowed is not true", async () => {
    await executeSystemFunction({
      label: "Close reviewed GitHub issue",
      work_item_id: "wi-action-spine-closure-guard",
      case_id: "case-system-action-spine",
      process_id: "developer-reviewer-github-issue",
      element_id: "f_close_issue",
      docIds: [],
      systems: [{ binding_id: "f_close_issue.issue.close", connector: "action_spine", operation: "issue.close" }],
      payload: {
        closure_allowed: false,
        action_args: {
          "f_close_issue.issue.close": { issue_number: 803, dry_run: true },
        },
      },
    });

    expect(state.audit).toHaveLength(0);
    expect(state.completed).toHaveLength(0);
    expect(state.updated).toHaveLength(1);
    expect(state.updated[0].patch).toMatchObject({
      status: "error",
      output: {
        system: "action_spine-error",
        action: "issue.close",
        binding_scope: "f_close_issue.issue.close",
        error: "issue.close requires closure_allowed=true",
      },
    });
  });
});

afterAll(() => {
  mock.restore();
});
