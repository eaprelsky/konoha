/**
 * tracker.ts — Yandex Tracker API Client.
 *
 * Handles HTTP, authorization, and issue search for Yandex Tracker REST API.
 * Does not know about MCP, Event Manager, or adapters — pure API layer.
 *
 * Config: token = TRACKER_TOKEN, orgId = TRACKER_CLOUD_ORG_ID.
 */

import type { ApiClientConfig } from "./types";

export interface TrackerIssue {
  id: string;
  key: string;
  summary: string;
  updatedAt: string;
  status?: { key: string };
  type?: { key: string };
  priority?: { key: string };
  queue?: { key: string };
  assignee?: { login: string };
  [key: string]: unknown;
}

export interface TrackerClientConfig extends ApiClientConfig {
  orgId: string;
}

export class TrackerClient {
  private token: string;
  private orgId: string;
  private baseUrl: string;

  constructor(config: TrackerClientConfig) {
    this.token = config.token;
    this.orgId = config.orgId;
    this.baseUrl = (config.baseUrl || "https://api.tracker.yandex.net/v2").replace(/\/$/, "");
  }

  async callMethod(path: string, options: RequestInit = {}): Promise<unknown> {
    if (!this.token || !this.orgId) throw new Error("TrackerClient: token/orgId not configured");

    const resp = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `OAuth ${this.token}`,
        "X-Cloud-Org-Id": this.orgId,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Tracker ${path} HTTP ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async searchIssues(filter: Record<string, unknown>): Promise<TrackerIssue[]> {
    return this.callMethod("/issues/_search", {
      method: "POST",
      body: JSON.stringify({ filter }),
    }) as Promise<TrackerIssue[]>;
  }

  async getIssue(issueKey: string): Promise<TrackerIssue> {
    return this.callMethod(`/issues/${issueKey}`) as Promise<TrackerIssue>;
  }
}
