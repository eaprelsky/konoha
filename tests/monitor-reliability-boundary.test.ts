import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(root, path), "utf-8");
}

describe("monitor reliability boundary", () => {
  test("documents infra monitor vs workflow-visible reliability responsibilities", () => {
    const doc = read("docs/monitor-reliability-boundary.md");

    expect(doc).toContain("Infra Monitor Runtime");
    expect(doc).toContain("Workflow-Visible Reliability");
    expect(doc).toContain("akamaru.service");
    expect(doc).toContain("scripts/healthcheck-system.py");
    expect(doc).toContain("reliability_operator");
    expect(doc).toContain("incident_owner");
    expect(doc).toContain("Do not rename");
  });

  test("lists actionable follow-up slices", () => {
    const doc = read("docs/monitor-reliability-boundary.md");
    const followUps = doc.match(/^\d+\. /gm) ?? [];
    expect(followUps.length).toBeGreaterThanOrEqual(5);
    expect(doc).toContain("reliability.signal");
    expect(doc).toContain("paused-service");
  });

  test("healthcheck and runbook point at the boundary", () => {
    expect(read("scripts/healthcheck-system.py")).toContain("docs/monitor-reliability-boundary.md");
    expect(read("docs/agent-operations-runbook.md")).toContain("docs/monitor-reliability-boundary.md");
  });
});
