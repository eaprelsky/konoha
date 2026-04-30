import { randomUUID } from "crypto";
import type { DataAdapter, ListenerHandle, QueryParams } from "./data-adapter";
import { listenerRegistry } from "./data-adapter";
import {
  githubEventMatchesFilter,
  type NormalizedGithubIssueEvent,
} from "../github-issue-events";

const filtersByHandle = new Map<string, Record<string, unknown>>();

export const githubAdapter: DataAdapter = {
  name: "github",

  async setupListener(filter: Record<string, unknown>, callback: (payload: unknown) => void): Promise<ListenerHandle> {
    const id = `github-${randomUUID()}`;
    filtersByHandle.set(id, filter);
    listenerRegistry.set(id, callback);
    return { id, adapter: "github" };
  },

  async removeListener(handle: ListenerHandle): Promise<void> {
    filtersByHandle.delete(handle.id);
    listenerRegistry.delete(handle.id);
  },

  async executeQuery(_query: QueryParams): Promise<number> {
    throw new Error("github condition queries are not implemented");
  },
};

export function dispatchGithubIssueEvent(event: NormalizedGithubIssueEvent): number {
  let delivered = 0;
  for (const [handleId, filter] of filtersByHandle.entries()) {
    if (!githubEventMatchesFilter(event, filter)) continue;
    const callback = listenerRegistry.get(handleId);
    if (!callback) continue;
    callback(event);
    delivered += 1;
  }
  return delivered;
}
