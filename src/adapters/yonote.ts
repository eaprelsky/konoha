// Yonote adapter for Konoha workflow runtime
// Env: YONOTE_API_KEY, YONOTE_BASE_URL (default: https://comindspace.yonote.ru/)

import type { Adapter } from "./bitrix24";

const BASE_URL = (process.env.YONOTE_BASE_URL || "https://comindspace.yonote.ru").replace(/\/$/, "");
const API_KEY = process.env.YONOTE_API_KEY || "";

async function yonoteFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Yonote API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// Action: get_document
// input: { doc_id }
// output: { id, title, content, ... }
async function getDocument(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { doc_id } = input;
  if (!doc_id) throw new Error("get_document: doc_id is required");
  const doc = await yonoteFetch<Record<string, unknown>>(`/api/v1/doc/${doc_id}`);
  return doc;
}

// Action: create_document
// input: { title, content, parent_id? }
// output: { id, title, ... }
async function createDocument(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { title, content, parent_id } = input;
  if (!title) throw new Error("create_document: title is required");
  const body: Record<string, unknown> = { title, content: content || "" };
  if (parent_id) body.parent_id = parent_id;
  const doc = await yonoteFetch<Record<string, unknown>>("/api/v1/doc", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return doc;
}

// Action: search
// input: { query }
// output: { results: [...] }
async function search(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { query } = input;
  if (!query) throw new Error("search: query is required");
  const results = await yonoteFetch<unknown[]>(`/api/v1/search?q=${encodeURIComponent(String(query))}`);
  return { results };
}

export const yonoteAdapter: Adapter = {
  async execute(action, input) {
    switch (action) {
      case "get_document":    return getDocument(input);
      case "create_document": return createDocument(input);
      case "search":          return search(input);
      default: throw new Error(`yonote: unknown action "${action}"`);
    }
  },

  async healthcheck() {
    if (!API_KEY) return false;
    try {
      await yonoteFetch("/api/v1/ping");
      return true;
    } catch {
      // try a lightweight authenticated request as fallback
      try {
        await yonoteFetch("/api/v1/doc?limit=1");
        return true;
      } catch {
        return false;
      }
    }
  },
};
