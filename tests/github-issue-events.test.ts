import { describe, expect, test } from "bun:test";
import {
  GITHUB_AGENT_KAKASHI_TRIGGER,
  GITHUB_AGENT_SHIKADAI_TRIGGER,
  githubEventMatchesFilter,
  isAgentKakashiIssueEvent,
  isAgentShikadaiIssueEvent,
  normalizeGithubIssueEvent,
} from "../src/github-issue-events";

describe("github issue connector events", () => {
  test("normalizes agent:kakashi issue label events", () => {
    const event = normalizeGithubIssueEvent("issues", {
      action: "labeled",
      repository: { full_name: "eaprelsky/konoha" },
      sender: { login: "itachi" },
      label: { name: "agent:kakashi" },
      issue: {
        number: 649,
        title: "Kakashi delegated backlog batch",
        html_url: "https://github.com/eaprelsky/konoha/issues/649",
        labels: [{ name: "agent:kakashi" }, { name: "priority:p2" }],
      },
    }, "2026-04-30T00:00:00.000Z");

    expect(event?.type).toBe("issue_labeled");
    expect(event?.repo).toBe("eaprelsky/konoha");
    expect(event?.issue_number).toBe(649);
    expect(event?.label).toBe("agent:kakashi");
    expect(event?.labels).toContain("priority:p2");
    expect(event && isAgentKakashiIssueEvent(event)).toBe(true);
    expect(event && githubEventMatchesFilter(event, GITHUB_AGENT_KAKASHI_TRIGGER.filter)).toBe(true);
    expect(event && githubEventMatchesFilter(event, {
      event: "issue_labeled",
      repo: "eaprelsky/konoha",
      label: "agent:kakashi",
      required_labels: ["agent:kakashi", "priority:p2"],
    })).toBe(true);
    expect(event && githubEventMatchesFilter(event, {
      event: "issue_labeled",
      required_labels: ["state:ready-for-dev"],
    })).toBe(false);
  });

  test("normalizes agent:shikadai issue label events", () => {
    const event = normalizeGithubIssueEvent("issues", {
      action: "labeled",
      repository: { full_name: "eaprelsky/konoha" },
      sender: { login: "itachi" },
      label: { name: "agent:shikadai" },
      issue: {
        number: 654,
        title: "Architecture decomposition intake",
        html_url: "https://github.com/eaprelsky/konoha/issues/654",
        labels: [{ name: "agent:shikadai" }, { name: "priority:p2" }],
      },
    }, "2026-04-30T00:00:00.000Z");

    expect(event?.type).toBe("issue_labeled");
    expect(event?.label).toBe("agent:shikadai");
    expect(event && isAgentShikadaiIssueEvent(event)).toBe(true);
    expect(event && githubEventMatchesFilter(event, GITHUB_AGENT_SHIKADAI_TRIGGER.filter)).toBe(true);
  });

  test("matches ready-for-dev workflow trigger when either required label was just added", () => {
    const event = normalizeGithubIssueEvent("issues", {
      action: "labeled",
      repository: { full_name: "eaprelsky/konoha" },
      sender: { login: "shikadai" },
      label: { name: "state:ready-for-dev" },
      issue: {
        number: 803,
        title: "Workflow migration",
        html_url: "https://github.com/eaprelsky/konoha/issues/803",
        labels: [{ name: "state:ready-for-dev" }, { name: "agent:kakashi" }],
      },
    });

    expect(event && githubEventMatchesFilter(event, {
      event: "issue_labeled",
      repo: "eaprelsky/konoha",
      required_labels: ["state:ready-for-dev", "agent:kakashi"],
    })).toBe(true);
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
