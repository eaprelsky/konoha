// Yandex Tracker adapter for Konoha workflow runtime
// Env: TRACKER_TOKEN, TRACKER_CLOUD_ORG_ID

import type { Adapter } from "./bitrix24";

const TRACKER_BASE = "https://api.tracker.yandex.net/v2";
const TOKEN = process.env.TRACKER_TOKEN || "";
const ORG_ID = process.env.TRACKER_CLOUD_ORG_ID || "";

async function trackerFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${TRACKER_BASE}${path}`, {
    ...options,
    headers: {
      "Authorization": `OAuth ${TOKEN}`,
      "X-Cloud-Org-Id": ORG_ID,
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Yandex Tracker API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// Action: create_issue
// input: { queue, summary, description? }
// output: { id, key, summary, ... }
async function createIssue(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { queue, summary, description } = input;
  if (!queue) throw new Error("create_issue: queue is required");
  if (!summary) throw new Error("create_issue: summary is required");
  const body: Record<string, unknown> = { queue: { key: String(queue) }, summary };
  if (description) body.description = description;
  const issue = await trackerFetch<Record<string, unknown>>("/issues", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return issue;
}

// Action: get_issue
// input: { issue_key }
// output: { id, key, summary, status, ... }
async function getIssue(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { issue_key } = input;
  if (!issue_key) throw new Error("get_issue: issue_key is required");
  const issue = await trackerFetch<Record<string, unknown>>(`/issues/${issue_key}`);
  return issue;
}

// Action: update_issue
// input: { issue_key, fields }
// output: { id, key, summary, ... }
async function updateIssue(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { issue_key, fields } = input;
  if (!issue_key) throw new Error("update_issue: issue_key is required");
  if (!fields || typeof fields !== "object") throw new Error("update_issue: fields object is required");
  const issue = await trackerFetch<Record<string, unknown>>(`/issues/${issue_key}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
  return issue;
}

// Action: list_issues
// input: { queue, filter? }
// output: { issues: [...] }
async function listIssues(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { queue, filter } = input;
  if (!queue) throw new Error("list_issues: queue is required");
  const body: Record<string, unknown> = { filter: { queue: String(queue) } };
  if (filter && typeof filter === "object") {
    Object.assign(body.filter as object, filter);
  }
  const issues = await trackerFetch<unknown[]>("/issues/_search", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { issues };
}

export const yandexTrackerAdapter: Adapter = {
  async execute(action, input) {
    switch (action) {
      case "create_issue": return createIssue(input);
      case "get_issue":    return getIssue(input);
      case "update_issue": return updateIssue(input);
      case "list_issues":  return listIssues(input);
      default: throw new Error(`yandex-tracker: unknown action "${action}"`);
    }
  },

  async healthcheck() {
    if (!TOKEN || !ORG_ID) return false;
    try {
      await trackerFetch("/myself");
      return true;
    } catch {
      return false;
    }
  },
};
