/**
 * assistant-response.test.ts
 *
 * Tests for issue #528 and #532:
 * - server-side assistant response normalization
 * - permission / confirmation semantics for assistant-driven workflow creation
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { normalizeAssistantResponse, buildSseParsedEvent } from "../src/assistant-response";
import { buildWorkflowObservableResult } from "../src/workflow-action-contract";
import { createWorkflow, getWorkflow, WORKFLOW_INDEX_KEY } from "../src/workflow-loader";
import { deleteCasesByProcess } from "../src/runtime";
import { createRole, deleteRole } from "../src/runtime/roles";
import { redis } from "../src/redis";
import { pgDeleteWorkflow } from "../src/storage/pg";

describe("normalizeAssistantResponse", () => {
  const baseOpts = { chat_id: "test-chat-1" };

  it("parses clean JSON with reply field", async () => {
    const raw = JSON.stringify({ reply: "Процесс создан!", create_workflow: null });
    const resp = await normalizeAssistantResponse(raw, baseOpts);
    expect(resp.reply).toBe("Процесс создан!");
    expect(resp.created_workflow).toBeNull();
    expect(resp.actions_taken).toHaveLength(0);
    expect(resp.pending_confirmations).toHaveLength(0);
  });

  it("parses JSON with markdown fences", async () => {
    const raw = '```json\n{"reply": "Готово!", "schema_patch": null}\n```';
    const resp = await normalizeAssistantResponse(raw, baseOpts);
    expect(resp.reply).toBe("Готово!");
  });

  it("handles non-JSON text gracefully", async () => {
    const raw = "Это обычный текст ответа от ассистента.";
    const resp = await normalizeAssistantResponse(raw, baseOpts);
    expect(resp.reply).toBe("Это обычный текст ответа от ассистента.");
    expect(resp.created_workflow).toBeNull();
    expect(resp.schema_patch).toBeNull();
  });

  it("extracts reply from 'text' field when 'reply' is missing", async () => {
    const raw = JSON.stringify({ text: "Ответ через text field" });
    const resp = await normalizeAssistantResponse(raw, baseOpts);
    expect(resp.reply).toBe("Ответ через text field");
  });

  it("extracts reply from 'message' field when others are missing", async () => {
    const raw = JSON.stringify({ message: "Ответ через message field" });
    const resp = await normalizeAssistantResponse(raw, baseOpts);
    expect(resp.reply).toBe("Ответ через message field");
  });

  it("generates summary when create_workflow present but no text field", async () => {
    const raw = JSON.stringify({
      create_workflow: { id: "test_proc", name: "Согласование", version: "1.0", elements: [], flow: [] },
    });
    const resp = await normalizeAssistantResponse(raw, baseOpts);
    expect(resp.reply).toContain("Согласование");
  });

  it("generates summary for schema_patch when no text", async () => {
    const raw = JSON.stringify({ schema_patch: { add_elements: [{ id: "x" }] } });
    const resp = await normalizeAssistantResponse(raw, baseOpts);
    expect(resp.reply).toBe("Схема обновлена.");
  });

  it("sanitizes raw JSON that couldn't be further processed", async () => {
    const raw = JSON.stringify({ foo: "bar", baz: 42 });
    const resp = await normalizeAssistantResponse(raw, baseOpts);
    expect(resp.reply).toBe("Выполнено.");
  });

  it("strips markdown fences from reply text", async () => {
    const raw = "```json\n{\"reply\": \"Done\"}\n```";
    const resp = await normalizeAssistantResponse(raw, baseOpts);
    expect(resp.reply).toBe("Done");
  });

  it("keeps schema_patch preview-only when no durable workflow target exists", async () => {
    const patch = { add_elements: [{ id: "new_el", type: "function", label: "Step" }] };
    const raw = JSON.stringify({ reply: "Добавил шаг", schema_patch: patch });
    const resp = await normalizeAssistantResponse(raw, baseOpts);
    expect(resp.schema_patch).toEqual(patch);
    expect(resp.action_receipts).toHaveLength(0);
    expect(resp.actions_taken[0]).toMatchObject({ action: "workflow.patch", status: "skipped" });
    expect(resp.observable_result.status).toBe("no_effect");
  });

  it("persists targeted schema_patch through workflow.patch before returning success receipt", async () => {
    const workflowId = `assistant-patch-${Date.now()}`;
    const roleId = `${workflowId}-role`;
    await createRole({ role_id: roleId, name: "Assistant patch role", strategy: "manual", assignees: [] });
    await createWorkflow({
      id: workflowId,
      version: "1.0",
      name: "Assistant Patch Test",
      elements: [
        { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
        { id: "review", type: "function", label: "Review", role: roleId },
        { id: "done", type: "event", label: "Done" },
      ],
      flow: [["start", "review"], ["review", "done"]],
    }, { draft: true });

    try {
      const raw = JSON.stringify({
        reply: "Переименовал процесс",
        schema_patch: { set_name: "Assistant Patch Saved" },
      });
      const resp = await normalizeAssistantResponse(raw, {
        ...baseOpts,
        current_workflow_id: workflowId,
        autonomy_overrides: { "workflow.patch": "auto" },
      });

      expect(resp.action_receipts[0]).toMatchObject({
        action: "workflow.patch",
        status: "succeeded",
        changed_resources: [{ kind: "workflow", id: workflowId, change: "updated" }],
      });
      expect(resp.action_receipts.some(receipt => receipt.action === "workflow.update" && receipt.status === "succeeded")).toBe(false);
      expect(resp.observable_result.status).toBe("succeeded");
      const saved = await getWorkflow(workflowId);
      expect(saved?.name).toBe("Assistant Patch Saved");
    } finally {
      await deleteCasesByProcess(workflowId).catch(() => 0);
      await redis.del(`workflow:${workflowId}`).catch(() => 0);
      await redis.srem(WORKFLOW_INDEX_KEY, workflowId).catch(() => 0);
      await pgDeleteWorkflow(workflowId).catch(() => 0);
      await deleteRole(roleId).catch(() => {});
    }
  });

  it("does not persist readiness-invalid assistant schema patches", async () => {
    const workflowId = `assistant-patch-invalid-${Date.now()}`;
    await createWorkflow({
      id: workflowId,
      version: "1.0",
      name: "Assistant Patch Invalid",
      elements: [],
      flow: [],
    }, { draft: true });

    try {
      const raw = JSON.stringify({
        reply: "Добавил шаг",
        schema_patch: {
          add_elements: [
            { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
            { id: "task", type: "function", label: "Task", systems: [{ connector: "missing-adapter", operation: "send" }] },
            { id: "done", type: "event", label: "Done" },
          ],
          add_flow: [["start", "task"], ["task", "done"]],
        },
      });
      const resp = await normalizeAssistantResponse(raw, {
        ...baseOpts,
        current_workflow_id: workflowId,
        autonomy_overrides: { "workflow.patch": "auto" },
      });

      expect(resp.action_receipts[0]).toMatchObject({ action: "workflow.patch", status: "failed" });
      expect(resp.observable_result.status).toBe("failed");
      const saved = await getWorkflow(workflowId);
      expect(saved?.elements).toEqual([]);
      expect(saved?.flow).toEqual([]);
    } finally {
      await deleteCasesByProcess(workflowId).catch(() => 0);
      await redis.del(`workflow:${workflowId}`).catch(() => 0);
      await redis.srem(WORKFLOW_INDEX_KEY, workflowId).catch(() => 0);
      await pgDeleteWorkflow(workflowId).catch(() => 0);
    }
  });

  it("extracts highlight UI actions", async () => {
    const raw = JSON.stringify({
      reply: "Смотри сюда",
      actions: [{ type: "highlight", selector: "#btn-start", message: "Кнопка" }],
    });
    const resp = await normalizeAssistantResponse(raw, baseOpts);
    expect(resp.ui_actions).toHaveLength(1);
    expect(resp.ui_actions[0].type).toBe("highlight");
    expect((resp.ui_actions[0] as any).target).toBe("#btn-start");
  });

  it("workflow creation requires confirmation by default", async () => {
    const raw = JSON.stringify({
      reply: "Создаю процесс",
      create_workflow: {
        id: "confirm-process",
        name: "Confirm Process",
        version: "1.0",
        elements: [],
        flow: [],
      },
    });
    const resp = await normalizeAssistantResponse(raw, {
      ...baseOpts,
      execute_actions: true,
      agent_id: "tsunade",
      session_id: "test-session",
    });
    expect(resp.created_workflow).toBeNull();
    expect(resp.actions_taken).toHaveLength(1);
    expect(resp.actions_taken[0].action).toBe("workflow.create");
    expect(resp.actions_taken[0].status).toBe("needs_confirm");
    expect(resp.pending_confirmations).toHaveLength(1);
    expect(resp.pending_confirmations[0].action).toBe("workflow.create");
    expect(resp.action_receipts.some(receipt => receipt.action === "workflow.create" && receipt.status === "pending_confirmation")).toBe(true);
    expect(resp.observable_result.status).toBe("pending_confirmation");
  });

  it("skips workflow creation when execute_actions is false", async () => {
    const raw = JSON.stringify({
      reply: "Создал бы процесс",
      create_workflow: {
        id: "skip_test",
        name: "Skip",
        version: "1.0",
        elements: [],
        flow: [],
      },
    });
    const resp = await normalizeAssistantResponse(raw, { ...baseOpts, execute_actions: false });
    expect(resp.created_workflow).toBeNull();
    expect(resp.actions_taken).toHaveLength(0);
    expect(resp.pending_confirmations).toHaveLength(0);
    expect(resp.action_receipts).toHaveLength(0);
    expect(resp.observable_result.status).toBe("no_effect");
  });

  it("normalizes workflow open requests into navigate actions and receipts", async () => {
    const resp = await normalizeAssistantResponse(JSON.stringify({
      reply: "Открываю процесс.",
      open_workflow: { id: "wf-open", name: "Открываемый процесс" },
    }), baseOpts);

    expect(resp.actions_taken[0].action).toBe("workflow.open");
    expect(resp.ui_actions[0]).toMatchObject({ type: "navigate", path: "/editor/wf-open" });
    expect(resp.action_receipts[0]).toMatchObject({
      action: "workflow.open",
      status: "succeeded",
      changed_resources: [{ kind: "workflow", id: "wf-open", label: "Открываемый процесс", change: "opened" }],
    });
    expect(resp.observable_result.status).toBe("succeeded");
  });

  it("executes case.start and returns observable run navigation", async () => {
    const processId = `assistant-start-${Date.now()}`;
    await createWorkflow({
      id: processId,
      version: "1.0",
      name: "Assistant Start Test",
      elements: [
        { id: "e1", type: "event", label: "Start" },
        { id: "f1", type: "function", label: "Review", role: "reviewer" },
        { id: "e2", type: "event", label: "Done" },
      ],
      flow: [["e1", "f1"], ["f1", "e2"]],
    }, { lifecycleState: "executable" });

    const resp = await normalizeAssistantResponse(JSON.stringify({
      reply: "Запускаю процесс.",
      start_case: {
        process_id: processId,
        subject: "Demo run",
        payload: { source: "assistant-test" },
      },
    }), { ...baseOpts, execute_actions: true, agent_id: "tsunade", session_id: "test-session" });

    expect(resp.actions_taken[0]).toMatchObject({ action: "case.start", status: "executed" });
    expect(resp.action_receipts[0]).toMatchObject({
      action: "case.start",
      status: "succeeded",
    });
    expect(resp.action_receipts[0].changed_resources.some(resource => resource.kind === "case" && resource.change === "started")).toBe(true);
    expect(resp.action_receipts[0].changed_resources.some(resource => resource.kind === "work_item" && resource.change === "pending")).toBe(true);
    expect(resp.action_receipts[0].summary).toContain("Следующая задача: Review -> reviewer");
    expect(resp.ui_actions[0]).toMatchObject({ type: "navigate" });
    expect(String(resp.ui_actions[0].path)).toContain("/monitor?case_id=");
    expect(resp.observable_result.status).toBe("succeeded");
  });

  it("starts the sales demo case and returns the next business-role work item", async () => {
    const processId = `assistant-sales-demo-${Date.now()}`;
    const rawWorkflow = readFileSync(join(import.meta.dir, "..", "workflows", "sales", "lead-qualification.json"), "utf-8");
    await createWorkflow({ ...JSON.parse(rawWorkflow), id: processId }, { lifecycleState: "executable" });

    try {
      const resp = await normalizeAssistantResponse(JSON.stringify({
        reply: "Запускаю демо продаж по Telegram-лиду.",
        start_case: {
          process_id: processId,
          subject: "Demo Telegram lead",
          payload: {
            chat_title: "coMind Лиды",
            text: "Нужен AI ассистент для заявок и КП",
            source: "demo",
          },
        },
      }), { ...baseOpts, execute_actions: true, agent_id: "tsunade", session_id: "sales-demo-session" });

      const receipt = resp.action_receipts.find(item => item.action === "case.start");
      expect(resp.actions_taken[0]).toMatchObject({ action: "case.start", status: "executed" });
      expect(receipt).toMatchObject({ action: "case.start", status: "succeeded" });
      expect(receipt?.summary).toContain("Следующая задача: Разобрать входящий сигнал -> lead_triage_specialist");
      expect(receipt?.summary).not.toContain("sasuke");
      expect(receipt?.changed_resources.some(resource =>
        resource.kind === "work_item"
        && resource.label === "Разобрать входящий сигнал"
        && resource.change === "pending"
      )).toBe(true);
      expect(resp.ui_actions[0]).toMatchObject({ type: "navigate" });
      expect(String(resp.ui_actions[0].path)).toContain("/monitor?case_id=");
      expect(resp.observable_result.status).toBe("succeeded");
    } finally {
      await deleteCasesByProcess(processId).catch(() => 0);
      await redis.del(`workflow:${processId}`).catch(() => 0);
      await redis.srem(WORKFLOW_INDEX_KEY, processId).catch(() => 0);
      await pgDeleteWorkflow(processId).catch(() => 0);
    }
  });
});

describe("workflow action contract", () => {
  it("builds a no-effect observable result for empty receipts", () => {
    expect(buildWorkflowObservableResult([])).toEqual({
      status: "no_effect",
      summary: "Изменений не зафиксировано.",
      receipts: [],
      counts: { succeeded: 0, pending_confirmation: 0, failed: 0, partial: 0 },
    });
  });

  it("prioritizes partial status when failures and successes are mixed", () => {
    const result = buildWorkflowObservableResult([
      { id: "ok", action: "workflow.update", status: "succeeded", summary: "ok", changed_resources: [], audit: { session_id: "s", action_type: "workflow.update" } },
      { id: "bad", action: "workflow.create", status: "failed", summary: "bad", changed_resources: [], audit: { session_id: "s", action_type: "workflow.create" } },
    ]);

    expect(result.status).toBe("partial");
    expect(result.counts.succeeded).toBe(1);
    expect(result.counts.failed).toBe(1);
  });
});

describe("buildSseParsedEvent", () => {
  it("builds correct SSE payload", () => {
    const resp = {
      reply: "Тест",
      chat_id: "ch1",
      schema_patch: null,
      created_workflow: null,
      actions_taken: [],
      pending_confirmations: [{ action: "workflow.create" }],
      action_receipts: [{ action: "workflow.create", status: "pending_confirmation", summary: "Pending" }],
      observable_result: { status: "pending_confirmation", summary: "Pending", receipts: [], counts: { succeeded: 0, pending_confirmation: 1, failed: 0, partial: 0 } },
      ui_actions: [{ type: "highlight" as const, selector: "#x" }],
    };
    const event = buildSseParsedEvent(resp as any);
    expect(event.type).toBe("parsed");
    expect(event.reply).toBe("Тест");
    expect(event.actions).toEqual(resp.ui_actions);
    expect(event.actions_taken).toEqual([]);
    expect(event.pending_confirmations).toEqual(resp.pending_confirmations);
    expect(event.action_receipts).toEqual(resp.action_receipts);
    expect(event.observable_result).toEqual(resp.observable_result);
  });
});
