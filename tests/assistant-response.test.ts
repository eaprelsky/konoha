/**
 * assistant-response.test.ts
 *
 * Tests for issue #528 and #532:
 * - server-side assistant response normalization
 * - permission / confirmation semantics for assistant-driven workflow creation
 */

import { describe, it, expect } from "bun:test";
import { normalizeAssistantResponse, buildSseParsedEvent } from "../src/assistant-response";

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

  it("extracts schema_patch from LLM output", async () => {
    const patch = { add_elements: [{ id: "new_el", type: "function", label: "Step" }] };
    const raw = JSON.stringify({ reply: "Добавил шаг", schema_patch: patch });
    const resp = await normalizeAssistantResponse(raw, baseOpts);
    expect(resp.schema_patch).toEqual(patch);
  });

  it("extracts highlight UI actions", async () => {
    const raw = JSON.stringify({
      reply: "Смотри сюда",
      actions: [{ type: "highlight", selector: "#btn-start", message: "Кнопка" }],
    });
    const resp = await normalizeAssistantResponse(raw, baseOpts);
    expect(resp.ui_actions).toHaveLength(1);
    expect(resp.ui_actions[0].type).toBe("highlight");
    expect(resp.ui_actions[0].selector).toBe("#btn-start");
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
      ui_actions: [{ type: "highlight" as const, selector: "#x" }],
    };
    const event = buildSseParsedEvent(resp as any);
    expect(event.type).toBe("parsed");
    expect(event.reply).toBe("Тест");
    expect(event.actions).toEqual(resp.ui_actions);
    expect(event.actions_taken).toEqual([]);
    expect(event.pending_confirmations).toEqual(resp.pending_confirmations);
  });
});
