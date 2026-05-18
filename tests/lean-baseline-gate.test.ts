import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

describe("lean baseline gate", () => {
  test("documents #776 as a prerequisite for BPMS refactor and staging rollout", () => {
    const gate = read("docs/lean-baseline-gate.md");

    expect(gate).toContain("Issue #776");
    expect(gate).toContain("Do not start a broad BPMS refactor rollout");
    expect(gate).toContain("staging deployment for #753");
    expect(gate).toContain("explicit waiver");
    expect(gate).toContain("KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py");
    expect(gate).toContain("KONOHA_SERVICE_PROFILE=staging-core");
  });

  test("records measured before/after resource evidence and the current exception", () => {
    const gate = read("docs/lean-baseline-gate.md");

    expect(gate).toContain("29 | 1,433,224");
    expect(gate).toContain("1 | about 86,900");
    expect(gate).toContain("9 | 378,000");
    expect(gate).toContain("0 | 0");
    expect(gate).toContain("Live inventory on 2026-05-18 08:24 MSK");
    expect(gate).toContain("documented exception required by #776");
    expect(gate).toContain("broad BPMS/staging rollout");
    expect(gate).toContain("remains blocked");
  });

  test("connects service profiles, testing docs, and architecture gate text", () => {
    const serviceProfiles = read("docs/service-profiles.md");
    const testing = read("docs/testing.md");
    const architecture = read("docs/architecture.md");

    expect(serviceProfiles).toContain("docs/lean-baseline-gate.md");
    expect(testing).toContain("docs/lean-baseline-gate.md");
    expect(testing).toContain("The #753 staging plan must use `staging-core`");
    expect(architecture).toContain("docs/lean-baseline-gate.md");
    expect(architecture).toContain("Naruto records a time-boxed waiver");
  });
});
