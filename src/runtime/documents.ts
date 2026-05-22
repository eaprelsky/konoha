/**
 * documents.ts — Document template CRUD + parameter extraction.
 * Extracted from runtime.ts (issue #338).
 */
import { randomUUID } from "crypto";
import { redis } from "../redis";
import { pgUpsertDoc, pgDeleteDoc, pgGetDoc, pgListDocs as pgListDocsRaw } from "../storage/pg";
import { isPgReadEnabledFor } from "../storage/pg-read-flags";

const DOC_KEY_PREFIX = "doc:";
const DOCS_IDX_ALL = "konoha:docs:all";

export type DocType = "prompt" | "instruction" | "form" | "template" | "attachment";

export interface DocTemplate {
  doc_id: string;
  name: string;
  type: DocType;
  content: string;
  parameters: string[];
  created_at: string;
  updated_at: string;
}

function isoStr(v: unknown): string {
  if (!v) return new Date().toISOString();
  return v instanceof Date ? v.toISOString() : String(v);
}

function extractParameters(content: string): string[] {
  const matches = content.match(/\{\{(\w+)\}\}/g) || [];
  return [...new Set(matches.map(m => m.slice(2, -2)))];
}

function pgRowToDoc(row: Record<string, unknown>): DocTemplate {
  return {
    doc_id: String(row.id),
    name: String(row.name ?? ''),
    type: (row.type ?? 'template') as DocType,
    content: String(row.content ?? ''),
    parameters: typeof row.parameters === 'object' && !Array.isArray(row.parameters)
      ? Object.keys(row.parameters as Record<string, unknown>)
      : Array.isArray(row.parameters) ? row.parameters as string[]
      : extractParameters(String(row.content ?? '')),
    created_at: isoStr(row.created_at),
    updated_at: isoStr(row.updated_at),
  };
}

async function saveDoc(d: DocTemplate): Promise<void> {
  d.parameters = extractParameters(d.content);
  await redis.set(DOC_KEY_PREFIX + d.doc_id, JSON.stringify(d));
  await redis.zadd(DOCS_IDX_ALL, new Date(d.created_at).getTime(), d.doc_id);
  pgUpsertDoc({ id: d.doc_id, name: d.name, type: d.type, content: d.content, parameters: {}, updated_at: new Date().toISOString() });
}

async function loadDoc(doc_id: string): Promise<DocTemplate | null> {
  if (isPgReadEnabledFor("documents")) {
    const row = await pgGetDoc(doc_id);
    return row ? pgRowToDoc(row) : null;
  }
  const raw = await redis.get(DOC_KEY_PREFIX + doc_id);
  return raw ? JSON.parse(raw) : null;
}

export async function createDoc(params: { name: string; type: DocType; content: string }): Promise<DocTemplate> {
  const now = new Date().toISOString();
  const d: DocTemplate = {
    doc_id: randomUUID(),
    name: params.name,
    type: params.type,
    content: params.content,
    parameters: extractParameters(params.content),
    created_at: now,
    updated_at: now,
  };
  await saveDoc(d);
  return d;
}

export async function upsertDoc(params: {
  doc_id: string;
  name: string;
  type?: DocType;
  content: string;
}): Promise<DocTemplate> {
  const now = new Date().toISOString();
  const existing = await loadDoc(params.doc_id);
  const d: DocTemplate = {
    doc_id: params.doc_id,
    name: params.name,
    type: params.type ?? "instruction",
    content: params.content,
    parameters: extractParameters(params.content),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  await saveDoc(d);
  return d;
}

export async function listDocs(): Promise<DocTemplate[]> {
  if (isPgReadEnabledFor("documents")) {
    const rows = await pgListDocsRaw();
    return rows.map(pgRowToDoc);
  }
  const ids = await redis.zrange(DOCS_IDX_ALL, 0, -1);
  const docs = await Promise.all(ids.map(id => loadDoc(id)));
  return docs.filter((d): d is DocTemplate => d !== null);
}

export async function updateDoc(doc_id: string, patch: Partial<Pick<DocTemplate, "name" | "type" | "content">>): Promise<DocTemplate> {
  const d = await loadDoc(doc_id);
  if (!d) throw new Error(`Document "${doc_id}" not found`);
  if (patch.name !== undefined)    d.name = patch.name;
  if (patch.type !== undefined)    d.type = patch.type;
  if (patch.content !== undefined) d.content = patch.content;
  d.updated_at = new Date().toISOString();
  await saveDoc(d);
  return d;
}

export async function deleteDoc(doc_id: string): Promise<void> {
  await redis.del(DOC_KEY_PREFIX + doc_id);
  await redis.zrem(DOCS_IDX_ALL, doc_id);
  pgDeleteDoc(doc_id);
}
