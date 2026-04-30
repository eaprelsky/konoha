import { describe, expect, test } from "bun:test";
import {
  GITHUB_DELEGATE_ARCHITECT_TRIGGER,
  GITHUB_DELEGATE_TEAMLEAD_TRIGGER,
  githubEventMatchesFilter,
  isDelegateArchitectIssueEvent,
  isDelegateTeamleadIssueEvent,
  normalizeGithubIssueEvent,
} from "../src/github-issue-events";

describe("github issue connector events", () => {
  test("normalizes delegate:teamlead issue label events", () => {
    const event = normalizeGithubIssueEvent("issues", {
      action: "labeled",
      repository: { full_name: "eaprelsky/konoha" },
      sender: { login: "itachi" },
      label: { name: "delegate:teamlead" },
      issue: {
        number: 649,
        title: "Kakashi delegated backlog batch",
        html_url: "https://github.com/eaprelsky/konoha/issues/649",
        labels: [{ name: "delegate:teamlead" }, { name: "kakashi-batch" }],
      },
    }, "2026-04-30T00:00:00.000Z");

    expect(event?.type).toBe("issue_labeled");
    expect(event?.repo).toBe("eaprelsky/konoha");
    expect(event?.issue_number).toBe(649);
    expect(event?.label).toBe("delegate:teamlead");
    expect(event?.labels).toContain("kakashi-batch");
    expect(event && isDelegateTeamleadIssueEvent(event)).toBe(true);
    expect(event && githubEventMatchesFilter(event, GITHUB_DELEGATE_TEAMLEAD_TRIGGER.filter)).toBe(true);
  });

  test("normalizes delegate:architect issue label events", () => {
    const event = normalizeGithubIssueEvent("issues", {
      action: "labeled",
      repository: { full_name: "eaprelsky/konoha" },
      sender: { login: "itachi" },
      label: { name: "delegate:architect" },
      issue: {
        number: 654,
        title: "Architecture decomposition intake",
        html_url: "https://github.com/eaprelsky/konoha/issues/654",
        labels: [{ name: "delegate:architect" }, { name: "P2" }],
      },
    }, "2026-04-30T00:00:00.000Z");

    expect(event?.type).toBe("issue_labeled");
    expect(event?.label).toBe("delegate:architect");
    expect(event && isDelegateArchitectIssueEvent(event)).toBe(true);
    expect(event && githubEventMatchesFilter(event, GITHUB_DELEGATE_ARCHITECT_TRIGGER.filter)).toBe(true);
  });

  test("normalizes issue comments", () => {
    const event = normalizeGithubIssueEvent("issue_comment", {
      action: "created",
      repository: { full_name: "eaprelsky/konoha" },
      sender: { login: "reviewer" },
      issue: { number: 637, title: "SDD harness", html_url: "https://github.test/637", labels: [] },
      comment: { id: 123, body: "Ready for review", html_url: "https://github.test/comment", user: { login: "reviewer" } },
    });

    expect(event?.type).toBe("issue_comment");
    expect(event?.comment?.body).toBe("Ready for review");
    expect(githubEventMatchesFilter(event!, { event: "issue_comment", repo: "eaprelsky/konoha" })).toBe(true);
  });

  test("normalizes branch readiness and review requests from pull requests", () => {
    const branchReady = normalizeGithubIssueEvent("pull_request", {
      action: "ready_for_review",
      repository: { full_name: "eaprelsky/konoha" },
      sender: { login: "developer" },
      pull_request: {
        number: 17,
        title: "Implement SDD harness",
        html_url: "https://github.test/pull/17",
        head: { ref: "kakashi/637-sdd-harness-workflow", sha: "abc123" },
        base: { ref: "main" },
        labels: [],
      },
    });
    const reviewRequested = normalizeGithubIssueEvent("pull_request", {
      action: "review_requested",
      repository: { full_name: "eaprelsky/konoha" },
      sender: { login: "developer" },
      requested_reviewer: { login: "reviewer" },
      pull_request: { number: 17, title: "Implement SDD harness", html_url: "https://github.test/pull/17", labels: [] },
    });

    expect(branchReady?.type).toBe("branch_ready");
    expect(branchReady?.branch?.name).toBe("kakashi/637-sdd-harness-workflow");
    expect(githubEventMatchesFilter(branchReady!, { event: "branch_ready", branch: "kakashi/637-sdd-harness-workflow" })).toBe(true);
    expect(reviewRequested?.type).toBe("review_requested");
    expect(reviewRequested?.review_request?.reviewer).toBe("reviewer");
  });

  test("normalizes only successful completed checks as checks_passed", () => {
    const passed = normalizeGithubIssueEvent("check_suite", {
      action: "completed",
      repository: { full_name: "eaprelsky/konoha" },
      sender: { login: "github-actions" },
      check_suite: {
        status: "completed",
        conclusion: "success",
        app: { name: "GitHub Actions" },
        pull_requests: [{ number: 17, html_url: "https://github.test/pull/17" }],
      },
    });
    const failed = normalizeGithubIssueEvent("check_suite", {
      action: "completed",
      repository: { full_name: "eaprelsky/konoha" },
      sender: { login: "github-actions" },
      check_suite: { status: "completed", conclusion: "failure" },
    });

    expect(passed?.type).toBe("checks_passed");
    expect(passed?.check?.conclusion).toBe("success");
    expect(failed).toBeNull();
  });
});
