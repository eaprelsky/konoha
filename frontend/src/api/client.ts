import type { Workflow, WorkItem, WorkItemFilters, Case, Reminder, ReminderStatus, RoleDef, DocTemplate, RuntimeEvent, Agent, Person, WorkspaceFile, KibaAction, Skill, ProcessMiningData } from './types';
export type { KibaAction };

// Nginx injects Bearer token into /api/* automatically — no token needed from client.

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
  });
  if (res.status === 401) throw new Error('Unauthorized — invalid API token');
  if (!res.ok) {
    let msg = `HTTP ${res.status}: ${res.statusText}`;
    try {
      const body = await res.json();
      if (Array.isArray(body?.details) && body.details.length > 0) {
        msg = body.details.map((d: any) => typeof d === 'string' ? d : (d.message || JSON.stringify(d))).join('\n');
      } else if (typeof body?.error === 'string') {
        msg = body.error;
      }
    } catch { /* body not JSON — keep default message */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

const BASE = '/api';

// ── Workflows ─────────────────────────────────────────────────────────────────

export const api = {
  workflows: {
    list: () => apiFetch<Workflow[]>(`${BASE}/workflows`),
    get: (id: string) => apiFetch<Workflow>(`${BASE}/workflows/${id}`),
    create: (body: Partial<Workflow> & { id: string; name: string }, draft = false) =>
      apiFetch<Workflow>(`${BASE}/workflows${draft ? '?draft=true' : ''}`, { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Partial<Workflow>, draft = false) =>
      apiFetch<Workflow>(`${BASE}/workflows/${id}${draft ? '?draft=true' : ''}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: string) =>
      apiFetch<{ ok: boolean }>(`${BASE}/workflows/${id}`, { method: 'DELETE' }),
  },

  workitems: {
    list: (filters?: WorkItemFilters) => {
      const p = new URLSearchParams();
      if (filters?.assignee)       p.set('assignee', filters.assignee);
      if (filters?.process_id)     p.set('process_id', filters.process_id);
      if (filters?.status)         p.set('status', filters.status);
      if (filters?.deadline_before) p.set('deadline_before', filters.deadline_before);
      const qs = p.toString();
      return apiFetch<WorkItem[]>(`${BASE}/workitems${qs ? '?' + qs : ''}`);
    },
    complete: (id: string, output?: Record<string, unknown>) =>
      apiFetch<WorkItem>(`${BASE}/workitems/${id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ output: output || {} }),
      }),
    create: (params: { label: string; assignee: string; deadline?: string; input?: Record<string, unknown> }) =>
      apiFetch<WorkItem>(`${BASE}/workitems`, {
        method: 'POST',
        body: JSON.stringify(params),
      }),
    deleteAll: () => apiFetch<{ deleted: number }>(`${BASE}/workitems/all`, { method: 'DELETE' }),
  },

  cases: {
    list: (filters?: { status?: string; process_id?: string; after?: string; before?: string; limit?: number; offset?: number }) => {
      const p = new URLSearchParams();
      if (filters?.status)     p.set('status', filters.status);
      if (filters?.process_id) p.set('process_id', filters.process_id);
      if (filters?.after)      p.set('after', filters.after);
      if (filters?.before)     p.set('before', filters.before);
      if (filters?.limit)      p.set('limit', String(filters.limit));
      if (filters?.offset)     p.set('offset', String(filters.offset));
      const qs = p.toString();
      return apiFetch<{ cases: Case[]; total: number }>(`${BASE}/cases${qs ? '?' + qs : ''}`);
    },
    get: (id: string) => apiFetch<Case>(`${BASE}/cases/${id}`),
  },

  events: {
    list: (filters?: { type?: string; after?: string; before?: string; limit?: number }) => {
      const p = new URLSearchParams();
      if (filters?.type)   p.set('type', filters.type);
      if (filters?.after)  p.set('after', filters.after);
      if (filters?.before) p.set('before', filters.before);
      if (filters?.limit)  p.set('limit', String(filters.limit));
      const qs = p.toString();
      return apiFetch<RuntimeEvent[]>(`${BASE}/events/log${qs ? '?' + qs : ''}`);
    },
  },

  agents: {
    list: () => apiFetch<Agent[]>(`${BASE}/agents`),
    get: (id: string) => apiFetch<Agent>(`${BASE}/agents/${id}`),
    create: (params: { id: string; name: string; system_prompt?: string; model?: string }) =>
      apiFetch<Agent>(`${BASE}/agents`, { method: 'POST', body: JSON.stringify(params) }),
    update: (id: string, patch: { name?: string; system_prompt?: string; model?: string }) =>
      apiFetch<Agent>(`${BASE}/agents/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    start: (id: string) => apiFetch<unknown>(`${BASE}/agents/${id}/start`, { method: 'POST', body: '{}' }),
    stop: (id: string) => apiFetch<unknown>(`${BASE}/agents/${id}/stop`, { method: 'POST', body: '{}' }),
    restart: (id: string) => apiFetch<unknown>(`${BASE}/agents/${id}/restart`, { method: 'POST', body: '{}' }),
    delete: (id: string) => apiFetch<{ ok: boolean }>(`${BASE}/agents/${id}?hard=true`, { method: 'DELETE' }),
    status: (id: string) => apiFetch<AgentStatus>(`${BASE}/agents/${id}/status`),
    tmuxLog: (id: string) => apiFetch<{ session: string; lines: string }>(`${BASE}/agents/tmux/${id}`),
    systemTemplate: (id: string) => apiFetch<{ template: string }>(`${BASE}/agents/${id}/system-template`),
    memoryList: (id: string) => apiFetch<{ name: string; size: number; updated_at: string }[]>(`${BASE}/agents/${id}/memory`),
    memoryRead: async (id: string, filename: string): Promise<string> => {
      const res = await fetch(`${BASE}/agents/${id}/memory/${encodeURIComponent(filename)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    memoryDelete: (id: string, filename: string) => apiFetch<{ ok: boolean }>(`${BASE}/agents/${id}/memory/${encodeURIComponent(filename)}`, { method: 'DELETE' }),
    generateAvatar: (id: string, params?: { style?: string; description?: string }) =>
      apiFetch<{ avatar_url: string }>(`${BASE}/agents/${id}/avatar`, { method: 'POST', body: JSON.stringify(params || {}) }),
  },

  roles: {
    list: () => apiFetch<RoleDef[]>(`${BASE}/roles`),
    create: (params: { role_id: string; name: string; description?: string; assignees?: string[]; strategy?: string }) =>
      apiFetch<RoleDef>(`${BASE}/roles`, { method: 'POST', body: JSON.stringify(params) }),
    update: (id: string, patch: Partial<RoleDef>) =>
      apiFetch<RoleDef>(`${BASE}/roles/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    delete: (id: string) => apiFetch<{ ok: boolean }>(`${BASE}/roles/${id}`, { method: 'DELETE' }),
  },

  documents: {
    list: () => apiFetch<DocTemplate[]>(`${BASE}/documents`),
    create: (params: { name: string; type?: string; content?: string }) =>
      apiFetch<DocTemplate>(`${BASE}/documents`, { method: 'POST', body: JSON.stringify(params) }),
    update: (id: string, patch: Partial<DocTemplate>) =>
      apiFetch<DocTemplate>(`${BASE}/documents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    delete: (id: string) => apiFetch<{ ok: boolean }>(`${BASE}/documents/${id}`, { method: 'DELETE' }),
  },

  adapters: {
    list: () => apiFetch<{ adapters: string[] }>(`${BASE}/adapters`),
    health: (name: string) => apiFetch<{ adapter: string; healthy: boolean }>(`${BASE}/adapters/${name}/health`),
  },

  reminders: {
    list: (filters?: { status?: ReminderStatus; recipient?: string }) => {
      const p = new URLSearchParams();
      if (filters?.status)    p.set('status', filters.status);
      if (filters?.recipient) p.set('recipient', filters.recipient);
      const qs = p.toString();
      return apiFetch<Reminder[]>(`${BASE}/reminders${qs ? '?' + qs : ''}`);
    },
    create: (params: {
      recipient: string;
      message: string;
      scheduled_at: string;
      channel?: string;
      type?: string;
    }) => apiFetch<Reminder>(`${BASE}/reminders`, { method: 'POST', body: JSON.stringify(params) }),
    acknowledge: (id: string) =>
      apiFetch<Reminder>(`${BASE}/reminders/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'acknowledged' }),
      }),
    delete: (id: string) =>
      apiFetch<{ ok: boolean }>(`${BASE}/reminders/${id}`, { method: 'DELETE' }),
  },

  messages: {
    history: (agentId: string, count = 50) =>
      apiFetch<KonohaMessage[]>(`${BASE}/messages/${agentId}/history?count=${count}`),
    send: (params: { from: string; to: string; text: string; type?: string }) =>
      apiFetch<{ id: string }>(`${BASE}/messages`, { method: 'POST', body: JSON.stringify(params) }),
  },

  people: {
    list: () => apiFetch<Person[]>(`${BASE}/people`),
    save: (p: Partial<Person>) => apiFetch<Person>(`${BASE}/people`, { method: 'POST', body: JSON.stringify(p) }),
    delete: (id: string) => apiFetch<{ ok: boolean }>(`${BASE}/people/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    generateAvatar: (id: string, params?: { style?: string; description?: string }) =>
      apiFetch<{ avatar_url: string }>(`${BASE}/people/${encodeURIComponent(id)}/avatar`, { method: 'POST', body: JSON.stringify(params || {}) }),
  },

  health: {
    bus: () => apiFetch<{ status: string; ts: string }>(`${BASE}/health`),
  },

  kb: {
    tree: () => apiFetch<KbNode[]>(`${BASE}/kb/tree`),
    file: (path: string) => apiFetch<{ content: string; path: string }>(`${BASE}/kb/file?path=${encodeURIComponent(path)}`),
    search: (q: string) => apiFetch<{ path: string }[]>(`${BASE}/kb/search?q=${encodeURIComponent(q)}`),
  },

  tsunade: {
    chat: (params: { message: string; schema?: unknown; chat_id?: string }) =>
      apiFetch<{ reply: string; chat_id: string; schema_patch: unknown | null }>(`${BASE}/tsunade/chat`, {
        method: 'POST',
        body: JSON.stringify(params),
      }),
    clearChat: (chat_id: string) =>
      apiFetch<{ ok: boolean }>(`${BASE}/tsunade/chat/${encodeURIComponent(chat_id)}`, { method: 'DELETE' }),
    processChat: (params: { message: string; schema?: unknown; chat_id?: string }) =>
      apiFetch<{ reply: string; chat_id: string; schema_patch: unknown | null }>(`${BASE}/ai/process-chat`, {
        method: 'POST',
        body: JSON.stringify(params),
      }),
    clearProcessChat: (chat_id: string) =>
      apiFetch<{ ok: boolean }>(`${BASE}/ai/process-chat/${encodeURIComponent(chat_id)}`, { method: 'DELETE' }),
  },

  kiba: {
    chat: (params: { message: string; context?: { page: string; data: unknown[] }; chat_id?: string }) =>
      apiFetch<{ reply: string; chat_id: string; actions: KibaAction[] }>(`${BASE}/ai/admin-chat`, {
        method: 'POST',
        body: JSON.stringify(params),
      }),
    clearChat: (chat_id: string) =>
      apiFetch<{ ok: boolean }>(`${BASE}/ai/admin-chat/${encodeURIComponent(chat_id)}`, { method: 'DELETE' }),
  },

  mining: {
    process: (id: string) => apiFetch<ProcessMiningData>(`${BASE}/mining/process/${encodeURIComponent(id)}`),
  },

  skills: {
    list: () => apiFetch<Skill[]>(`${BASE}/skills`),
    create: (params: { id?: string; name: string; name_en?: string; description?: string; prompt_snippet?: string; tools?: string[] }) =>
      apiFetch<Skill>(`${BASE}/skills`, { method: 'POST', body: JSON.stringify(params) }),
    update: (id: string, patch: Partial<Omit<Skill, 'id' | 'created_at' | 'updated_at'>>) =>
      apiFetch<Skill>(`${BASE}/skills/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    delete: (id: string) =>
      apiFetch<{ ok: boolean }>(`${BASE}/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },

  jiraiya: {
    chat: (params: { message: string; file_path?: string; chat_id?: string }) =>
      apiFetch<{ reply: string; chat_id: string; sources: string[] }>(`${BASE}/ai/kb-chat`, {
        method: 'POST',
        body: JSON.stringify(params),
      }),
    clearChat: (chat_id: string) =>
      apiFetch<{ ok: boolean }>(`${BASE}/ai/kb-chat/${encodeURIComponent(chat_id)}`, { method: 'DELETE' }),
  },

  workspace: {
    list: () => apiFetch<WorkspaceFile[]>(`${BASE}/workspace/files`),
    upload: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return apiFetch<{ name: string; size: number }>(`${BASE}/workspace/upload`, { method: 'POST', body: fd });
    },
    delete: (name: string) => apiFetch<{ ok: boolean }>(`${BASE}/workspace/files/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  },
};

export { getToken, ensureToken };
