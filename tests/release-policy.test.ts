import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

describe("canonical release policy", () => {
  test("defines release types, gates, labels, rollback, and audit evidence", () => {
    const policy = read("docs/release-policy.md");

    for (const releaseType of ["Normal release", "Hotfix", "Emergency bypass", "Infra-only change", "Docs-only change"]) {
      expect(policy).toContain(releaseType);
    }

    expect(policy).toContain("scripts/preflight-portable.sh");
    expect(policy).toContain("scripts/preflight.sh");
    expect(policy).toContain("scripts/pre-release-gate.py");
    expect(policy).toContain("KONOHA_SERVICE_PROFILE=staging-core");
    expect(policy).toContain("Redis DB `2`");
    expect(policy).toContain("PostgreSQL `konoha_staging`");
    expect(policy).toContain("priority:p0");
    expect(policy).toContain("risk:critical");
    expect(policy).toContain("risk:regression");
    expect(policy).toContain("state:ready-for-test");
    expect(policy).toContain("Emergency release bypass accepted");
    expect(policy).toContain("Reverting code does not revert Redis streams");
    expect(policy).toContain("#686");
    expect(policy).toContain("#795");
    expect(policy).toContain("#793");
    expect(policy).toContain("#794");
    expect(policy).toContain("#682, #733, #734, #735, and #736");
  });

  test("docs and agent instructions point to the release policy", () => {
    const files = [
      "docs/testing.md",
      "docs/architecture.md",
      "agents/naruto/AGENTS.md",
      "agents/kakashi/AGENTS.md",
      "agents/shikadai/AGENTS.md",
    ];

    for (const file of files) {
      expect(read(file)).toContain("docs/release-policy.md");
    }
  });

  test("pre-release gate uses canonical labels and no legacy release labels", () => {
    const script = read("scripts/pre-release-gate.py");

    expect(script).toContain("docs/release-policy.md");
    expect(script).toContain("priority:p0");
    expect(script).toContain("risk:critical");
    expect(script).toContain("risk:regression");
    expect(script).toContain("legacy_release_labels");
    expect(script).not.toContain("--label\", \"P0");
    expect(script).not.toContain("--label\", \"P0: critical");
    expect(script).not.toContain("--label\", \"needs-testing");
  });
});
