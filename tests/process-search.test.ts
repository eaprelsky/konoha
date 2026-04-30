import { describe, expect, test } from "bun:test";
import { workflowDisplayName, workflowMatchesSearch, workflowTitle } from "../frontend/src/pages/processSearch";

const namedWorkflow = {
  id: "lead-qualification",
  name: "Продажи: входящий лид",
};

describe("process tree workflow search", () => {
  test("matches named workflows by canonical id", () => {
    expect(workflowMatchesSearch(namedWorkflow, "lead-qualification")).toBe(true);
  });

  test("matches named workflows by display name", () => {
    expect(workflowMatchesSearch(namedWorkflow, "входящий")).toBe(true);
  });

  test("exposes canonical id in title when display name differs", () => {
    expect(workflowDisplayName(namedWorkflow)).toBe("Продажи: входящий лид");
    expect(workflowTitle(namedWorkflow)).toBe("Продажи: входящий лид (lead-qualification)");
  });
});
