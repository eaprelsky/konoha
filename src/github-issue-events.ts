import type { MessageTrigger } from "./events/types";

export type GithubIssueConnectorEventType =
  | "issue_labeled"
  | "issue_comment"
  | "branch_ready"
  | "checks_passed"
  | "review_requested";

export interface NormalizedGithubIssueEvent {
  type: GithubIssueConnectorEventType;
  provider: "github";
  repo: string;
  sender: string;
  issue_number: number | null;
  issue_title: string | null;
  issue_url: string | null;
  labels: string[];
  label?: string;
  comment?: {
    id?: number;
    body?: string;
    url?: string;
    author?: string;
  };
  branch?: {
    name?: string;
    sha?: string;
    base?: string;
  };
  check?: {
    name?: string;
    conclusion?: string;
    status?: string;
  };
  review_request?: {
    reviewer?: string;
    team?: string;
  };
  raw_event: string;
  raw_action: string;
  received_at: string;
}

export const GITHUB_AGENT_KAKASHI_TRIGGER: MessageTrigger = {
  kind: "message",
  source: "github",
  filter: {
    event: "issue_labeled",
    label: "agent:kakashi",
  },
};

export const GITHUB_AGENT_SHIKADAI_TRIGGER: MessageTrigger = {
  kind: "message",
  source: "github",
  filter: {
    event: "issue_labeled",
    label: "agent:shikadai",
  },
};

export function normalizeGithubIssueEvent(
  githubEvent: string,
  payload: Record<string, unknown>,
  receivedAt = new Date().toISOString(),
): NormalizedGithubIssueEvent | null {
  const action = stringField(payload.action);
  const repo = stringField((payload.repository as any)?.full_name);
  const sender = stringField((payload.sender as any)?.login);
  const issue = (payload.issue ?? payload.pull_request) as any;
  const pullRequest = payload.pull_request as any;
  const base = baseEvent(githubEvent, action, repo, sender, issue, receivedAt);

  if (githubEvent === "issues" && action === "labeled") {
    const label = stringField((payload.label as any)?.name);
    return {
      ...base,
      type: "issue_labeled",
      label,
      labels: labelsFromIssue(issue),
    };
  }

  if (githubEvent === "issue_comment" && (action === "created" || action === "edited")) {
    const comment = payload.comment as any;
    return {
      ...base,
      type: "issue_comment",
      labels: labelsFromIssue(issue),
      comment: {
        id: numberField(comment?.id) ?? undefined,
        body: stringField(comment?.body) || undefined,
        url: stringField(comment?.html_url) || undefined,
        author: stringField(comment?.user?.login) || undefined,
      },
    };
  }

  if (githubEvent === "pull_request" && ["opened", "reopened", "synchronize", "ready_for_review"].includes(action)) {
    return {
      ...base,
      type: "branch_ready",
      labels: labelsFromIssue(pullRequest),
      branch: {
        name: stringField(pullRequest?.head?.ref) || undefined,
        sha: stringField(pullRequest?.head?.sha) || undefined,
        base: stringField(pullRequest?.base?.ref) || undefined,
      },
    };
  }

  if (githubEvent === "pull_request" && action === "review_requested") {
    return {
      ...base,
      type: "review_requested",
      labels: labelsFromIssue(pullRequest),
      review_request: {
        reviewer: stringField((payload.requested_reviewer as any)?.login) || undefined,
        team: stringField((payload.requested_team as any)?.name) || undefined,
      },
    };
  }

  if (githubEvent === "check_suite" && action === "completed") {
    const suite = payload.check_suite as any;
    if (stringField(suite?.conclusion) !== "success") return null;
    const pr = Array.isArray(suite?.pull_requests) ? suite.pull_requests[0] : undefined;
    return {
      ...baseEvent(githubEvent, action, repo, sender, pr ?? null, receivedAt),
      type: "checks_passed",
      labels: [],
      check: {
        name: stringField(suite?.app?.name) || "check_suite",
        conclusion: stringField(suite?.conclusion) || undefined,
        status: stringField(suite?.status) || undefined,
      },
    };
  }

  if (githubEvent === "check_run" && action === "completed") {
    const run = payload.check_run as any;
    if (stringField(run?.conclusion) !== "success") return null;
    const pr = Array.isArray(run?.pull_requests) ? run.pull_requests[0] : undefined;
    return {
      ...baseEvent(githubEvent, action, repo, sender, pr ?? null, receivedAt),
      type: "checks_passed",
      labels: [],
      check: {
        name: stringField(run?.name) || undefined,
        conclusion: stringField(run?.conclusion) || undefined,
        status: stringField(run?.status) || undefined,
      },
    };
  }

  return null;
}

export function githubEventMatchesFilter(
  event: NormalizedGithubIssueEvent,
  filter: Record<string, unknown>,
): boolean {
  if (filter.event && filter.event !== event.type) return false;
  if (filter.repo && filter.repo !== event.repo) return false;
  if (filter.label && filter.label !== event.label) return false;
  if (Array.isArray(filter.required_labels)) {
    const labels = new Set(event.labels);
    if (!filter.required_labels.every(label => typeof label === "string" && labels.has(label))) return false;
  }
  if (filter.issue_number && Number(filter.issue_number) !== event.issue_number) return false;
  if (filter.branch && filter.branch !== event.branch?.name) return false;
  if (filter.base && filter.base !== event.branch?.base) return false;
  if (filter.check_name && filter.check_name !== event.check?.name) return false;
  return true;
}

export function isAgentKakashiIssueEvent(event: NormalizedGithubIssueEvent): boolean {
  return event.type === "issue_labeled" && event.label === "agent:kakashi";
}

export function isAgentShikadaiIssueEvent(event: NormalizedGithubIssueEvent): boolean {
  return event.type === "issue_labeled" && event.label === "agent:shikadai";
}

function baseEvent(
  githubEvent: string,
  action: string,
  repo: string,
  sender: string,
  issue: any,
  receivedAt: string,
): Omit<NormalizedGithubIssueEvent, "type"> {
  return {
    provider: "github",
    repo,
    sender,
    issue_number: numberField(issue?.number),
    issue_title: stringField(issue?.title) || null,
    issue_url: stringField(issue?.html_url) || null,
    labels: labelsFromIssue(issue),
    raw_event: githubEvent,
    raw_action: action,
    received_at: receivedAt,
  };
}

function labelsFromIssue(issue: any): string[] {
  const labels = issue?.labels;
  if (!Array.isArray(labels)) return [];
  return labels.map((label: any) => stringField(label?.name ?? label)).filter(Boolean);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
