import { describe, expect, test } from "bun:test";
import { ACTION_VERSION } from "../src/action-registry";
import { runActionSpineCli } from "../scripts/action-spine-cli";

function parseStdout(result: Awaited<ReturnType<typeof runActionSpineCli>>) {
  return JSON.parse(result.stdout);
}

describe("Action Spine CLI bridge", () => {
  test("prints help with a successful exit code", async () => {
    const result = await runActionSpineCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).toBe("");
  });

  test("invokes a read action through the direct action executor", async () => {
    const result = await runActionSpineCli(["workflow.list", "{}"]);
    const body = parseStdout(result);

    expect(result.exitCode).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("workflow.list");
    expect(body.action_version).toBe(ACTION_VERSION);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("supports write action contract validation in dry-run mode", async () => {
    const result = await runActionSpineCli([
      "workflow.create",
      JSON.stringify({ elements: [], flow: [], draft: true }),
      "--dry-run",
    ]);
    const body = parseStdout(result);

    expect(result.exitCode).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("workflow.create");
    expect(body.data).toEqual({
      dry_run: true,
      category: "act",
      args: { elements: [], flow: [], draft: true },
    });
  });

  test("returns Action Spine envelope validation errors", async () => {
    const result = await runActionSpineCli(["workflow.create", "{}"]);
    const body = parseStdout(result);

    expect(result.exitCode).toBe(1);
    expect(body.ok).toBe(false);
    expect(body.action).toBe("workflow.create");
    expect(body.error).toContain("Validation:");
    expect(body.error).toContain("Missing required argument: elements");
    expect(body.error).toContain("Missing required argument: flow");
  });

  test("requires explicit dry-run or execute flag for mutation actions", async () => {
    const result = await runActionSpineCli([
      "workflow.create",
      JSON.stringify({ elements: [], flow: [] }),
    ]);
    const body = parseStdout(result);

    expect(result.exitCode).toBe(1);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Mutation actions require --dry-run or --execute-write");
  });
});
