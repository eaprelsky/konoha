import { describe, expect, test } from "bun:test";
import { executeActionDirect } from "../src/action-executor";
import { classifyAction, getAction, validateActionArgs } from "../src/action-registry";
import { executeGithubIssueAction } from "../src/github-issue-actions";

describe("GitHub issue Action Spine actions", () => {
  test("registry exposes issue side-effect actions", () => {
    for (const id of ["issue.get", "issue.list", "issue.comment", "issue.update_labels", "issue.close"]) {
      expect(getAction(id)).toBeDefined();
      expect(validateActionArgs(id, id === "issue.list" ? {} : { issue_number: 803, body: "x", add_labels: ["state:ready-for-review"] }).valid).toBe(true);
    }
    expect(classifyAction("issue.comment")).toBe("act");
    expect(classifyAction("issue.update_labels")).toBe("act");
    expect(classifyAction("issue.close")).toBe("act");
  });

  test("builds dry-run commands for label update and close", async () => {
    const update = await executeActionDirect("issue.update_labels", {
      issue_number: 803,
      add_labels: ["state:ready-for-review", "agent:shikadai"],
      remove_labels: ["state:ready-for-dev", "agent:kakashi"],
      dry_run: true,
    });
    const close = await executeActionDirect("issue.close", {
      issue_number: 803,
      comment: "Approved by reviewer",
      dry_run: true,
    });

    expect(update?.status).toBe(200);
    expect(update?.data).toEqual({
      dry_run: true,
      command: [
        "gh", "issue", "edit", "803", "--repo", "eaprelsky/konoha",
        "--add-label", "state:ready-for-review",
        "--add-label", "agent:shikadai",
        "--remove-label", "state:ready-for-dev",
        "--remove-label", "agent:kakashi",
      ],
    });
    expect(close?.data).toEqual({
      dry_run: true,
      command: ["gh", "issue", "close", "803", "--repo", "eaprelsky/konoha", "--comment", "Approved by reviewer"],
    });
  });

  test("parses issue.get and issue.list JSON output through injectable runner", async () => {
    const getResult = await executeGithubIssueAction("issue.get", { issue_number: 803 }, {
      runner: () => JSON.stringify({ number: 803, title: "Workflow migration" }),
    });
    const listResult = await executeGithubIssueAction("issue.list", { labels: ["priority:p0"], limit: 10 }, {
      runner: () => JSON.stringify([{ number: 803 }, { number: 804 }]),
    });

    expect(getResult?.data).toEqual({ number: 803, title: "Workflow migration" });
    expect(listResult?.data).toEqual([{ number: 803 }, { number: 804 }]);
  });

  test("rejects label updates without add or remove labels", async () => {
    const result = await executeActionDirect("issue.update_labels", { issue_number: 803 });
    expect(result?.status).toBe(400);
    expect(result?.data).toEqual({ error: "add_labels or remove_labels required" });
  });
});
