/**
 * Unit tests for applyPatchToState (pure schema-patch transformation).
 * Extracted from useProcessEditor.applyPatch (issue #461, covers #424 logic).
 *
 * No React/DOM required — pure TypeScript transformation function.
 */

import { describe, test, expect } from "bun:test";
import { applyPatchToState, type PatchState } from "../frontend/src/pages/applyPatchHelper";

function emptyState(): PatchState {
  return { elements: [], flow: [], positions: {} };
}

function stateWith(...els: { id: string; type?: string; label?: string }[]): PatchState {
  return {
    elements: els.map(e => ({ id: e.id, type: (e.type ?? "event") as any, label: e.label ?? e.id })),
    flow: [],
    positions: Object.fromEntries(els.map(e => [e.id, { x: 0, y: 0 }])),
  };
}

describe("applyPatchToState — add_elements", () => {
  test("adds element with explicit id and label", () => {
    const result = applyPatchToState(emptyState(), {
      add_elements: [{ id: "f1", type: "function", label: "Approve", x: 200, y: 300 }],
    });
    expect(result.elements).toHaveLength(1);
    const el = result.elements[0];
    expect(el.id).toBe("f1");
    expect(el.type).toBe("function");
    expect(el.label).toBe("Approve");
    expect(result.positions["f1"]).toEqual({ x: 200, y: 300 });
  });

  test("generates id when not provided", () => {
    const result = applyPatchToState(emptyState(), {
      add_elements: [{ type: "event", label: "Start" }],
    });
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].id).toBeTruthy();
    expect(result.elements[0].id).toMatch(/^event-/);
  });

  test("uses fallback label when not provided", () => {
    const result = applyPatchToState(emptyState(), {
      add_elements: [{ id: "g1", type: "gateway" }],
    });
    expect(result.elements[0].label).toBe("Новое ветвление");
  });

  test("defaults position to (100, 100) when x/y omitted", () => {
    const result = applyPatchToState(emptyState(), {
      add_elements: [{ id: "e1", type: "event", label: "E" }],
    });
    expect(result.positions["e1"]).toEqual({ x: 100, y: 100 });
  });

  test("existing elements are preserved", () => {
    const state = stateWith({ id: "e1", type: "event", label: "Existing" });
    const result = applyPatchToState(state, {
      add_elements: [{ id: "f1", type: "function", label: "New" }],
    });
    expect(result.elements).toHaveLength(2);
    expect(result.elements.find(e => e.id === "e1")).toBeDefined();
    expect(result.elements.find(e => e.id === "f1")).toBeDefined();
  });
});

describe("applyPatchToState — remove_elements", () => {
  test("removes element by id", () => {
    const state = stateWith({ id: "e1" }, { id: "f1" });
    const result = applyPatchToState(state, { remove_elements: ["e1"] });
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].id).toBe("f1");
    expect(result.positions["e1"]).toBeUndefined();
  });

  test("removes connected flow edges", () => {
    const state: PatchState = {
      elements: [
        { id: "e1", type: "event" as any, label: "A" },
        { id: "f1", type: "function" as any, label: "B" },
        { id: "e2", type: "event" as any, label: "C" },
      ],
      flow: [["e1", "f1"], ["f1", "e2"]],
      positions: { e1: { x: 0, y: 0 }, f1: { x: 1, y: 0 }, e2: { x: 2, y: 0 } },
    };
    const result = applyPatchToState(state, { remove_elements: ["f1"] });
    expect(result.elements).toHaveLength(2);
    expect(result.flow).toHaveLength(0);
  });
});

describe("applyPatchToState — update_elements", () => {
  test("updates matching element fields", () => {
    const state = stateWith({ id: "f1", type: "function", label: "Old Label" });
    const result = applyPatchToState(state, {
      update_elements: [{ id: "f1", label: "New Label", role: "manager" }],
    });
    const el = result.elements.find(e => e.id === "f1")!;
    expect(el.label).toBe("New Label");
    expect((el as any).role).toBe("manager");
  });

  test("non-matching elements are unchanged", () => {
    const state = stateWith({ id: "e1", label: "Keep Me" }, { id: "f1", label: "Change Me" });
    const result = applyPatchToState(state, {
      update_elements: [{ id: "f1", label: "Changed" }],
    });
    expect(result.elements.find(e => e.id === "e1")!.label).toBe("Keep Me");
    expect(result.elements.find(e => e.id === "f1")!.label).toBe("Changed");
  });
});

describe("applyPatchToState — add_flow / remove_flow", () => {
  test("adds flow edge", () => {
    const state = stateWith({ id: "e1" }, { id: "f1" });
    const result = applyPatchToState(state, { add_flow: [["e1", "f1"]] });
    expect(result.flow).toHaveLength(1);
    expect(result.flow[0]).toEqual(["e1", "f1"]);
  });

  test("does not add duplicate flow edges", () => {
    const state: PatchState = {
      elements: [{ id: "e1", type: "event" as any, label: "E" }, { id: "f1", type: "function" as any, label: "F" }],
      flow: [["e1", "f1"]],
      positions: {},
    };
    const result = applyPatchToState(state, { add_flow: [["e1", "f1"]] });
    expect(result.flow).toHaveLength(1);
  });

  test("removes flow edge", () => {
    const state: PatchState = {
      elements: [],
      flow: [["e1", "f1"], ["f1", "e2"]],
      positions: {},
    };
    const result = applyPatchToState(state, { remove_flow: [["e1", "f1"]] });
    expect(result.flow).toHaveLength(1);
    expect(result.flow[0]).toEqual(["f1", "e2"]);
  });
});

describe("applyPatchToState — update_positions", () => {
  test("merges positions", () => {
    const state = stateWith({ id: "e1" }, { id: "f1" });
    const result = applyPatchToState(state, {
      update_positions: { e1: { x: 500, y: 200 } },
    });
    expect(result.positions["e1"]).toEqual({ x: 500, y: 200 });
    expect(result.positions["f1"]).toEqual({ x: 0, y: 0 });
  });
});

describe("applyPatchToState — empty patch", () => {
  test("returns equivalent state when patch is empty", () => {
    const state = stateWith({ id: "e1" }, { id: "f1" });
    const result = applyPatchToState(state, {});
    expect(result.elements).toEqual(state.elements);
    expect(result.flow).toEqual(state.flow);
    expect(result.positions).toEqual(state.positions);
  });
});
