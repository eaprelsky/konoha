import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

describe("ADR-006 Konoha packaging and deployment boundaries", () => {
  test("selects monorepo multi-service as the target without immediate refactor", () => {
    const adr = read("docs/adr-006-konoha-packaging-and-deployment-boundaries.md");

    expect(adr).toContain("Choose **Option B: monorepo, multiple deployable services over time**");
    expect(adr).toMatch(/production remains a modular\s+monolith/);
    expect(adr).toMatch(/No behavior-heavy package move should happen before this ADR\s+is accepted/);
    expect(adr).not.toContain("Choose **Option C");
  });

  test("documents target boundaries and dependency direction", () => {
    const adr = read("docs/adr-006-konoha-packaging-and-deployment-boundaries.md");
    const boundaries = [
      "@konoha/bus",
      "@konoha/workflow-engine",
      "@konoha/web",
      "@konoha/action-spine",
      "@konoha/agent-runtime",
      "@konoha/connectors",
      "@konoha/testbench",
    ];

    for (const boundary of boundaries) {
      expect(adr).toContain(boundary);
    }

    expect(adr).toContain("## Allowed Dependencies");
    expect(adr).toContain("## Forbidden Dependencies");
    expect(adr).toContain("Workflow Engine is a **product module with a stable API**");
    expect(adr).toContain("cross-boundary writes go through Action Spine actions or normalized events");
  });

  test("keeps old dashboard ops-only and links the architecture overview", () => {
    const adr = read("docs/adr-006-konoha-packaging-and-deployment-boundaries.md");
    const architecture = read("docs/architecture.md");

    expect(adr).toContain("`konoha-dashboard` is **legacy ops-only**");
    expect(adr).toContain("do not add product features there");
    expect(adr).toContain("retire `konoha-dashboard.service`");
    expect(architecture).toContain("docs/adr-006-konoha-packaging-and-deployment-boundaries.md");
  });
});
