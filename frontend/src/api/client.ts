import type { Workflow, WorkItem, WorkItemFilters, Case, Reminder, ReminderStatus, RoleDef, DocTemplate, RuntimeEvent, Agent } from './types';

// Token stored in localStorage, readable via ?token= query param
function getToken(): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('token');
  if (fromUrl) {
    localStorage.setItem('konoha_token', fromUrl);
    return fromUrl;
  }
  return localStorage.getItem('konoha_token') || '';
}

function ensureToken(): string {
  let token = getToken();
  if (!token) {
    token = prompt('Konoha API token:') || '';
    if (token) localStorage.setItem('konoha_token', token);
  }
  return token;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = ensureToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
  });
  if (res.status === 401) throw new Error('Unauthorized — invalid API token');
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

const BASE = '/api';

// ── Workflows ─────────────────────────────────────────────────────────────────

export const api = {
  workflows: {
    list: () => apiFetch<Workflow[]>(`${BASE}/workflows`),
    get: (id: string) => apiFetch<Workflow>(`${BASE}/workflows/${id}`),
    create: (body: Partial<Workflow> & { id: string; name: string }) =>
      apiFetch<Workflow>(`${BASE}/workflows`, { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Partial<Workflow>) =>
      apiFetch<Workflow>(`${BASE}/workflows/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
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
    create: (params: { id: string; name: string; system_prompt?: string; model?: string }) =>
      apiFetch<Agent>(`${BASE}/agents`, { method: 'POST', body: JSON.stringify(params) }),
    start: (id: string) => apiFetch<unknown>(`${BASE}/agents/${id}/start`, { method: 'POST', body: '{}' }),
    stop: (id: string) => apiFetch<unknown>(`${BASE}/agents/${id}/stop`, { method: 'POST', body: '{}' }),
    restart: (id: string) => apiFetch<unknown>(`${BASE}/agents/${id}/restart`, { method: 'POST', body: '{}' }),
    delete: (id: string) => apiFetch<{ ok: boolean }>(`${BASE}/agents/${id}`, { method: 'DELETE' }),
    status: (id: string) => apiFetch<AgentStatus>(`${BASE}/agents/${id}/status`),
    tmuxLog: (id: string) => apiFetch<{ session: string; lines: string }>(`${BASE}/agents/tmux/${id}`),
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

  health: {
    bus: () => apiFetch<{ status: string; ts: string }>(`${BASE}/health`),
  },

  kb: {
    tree: () => apiFetch<KbNode[]>(`${BASE}/kb/tree`),
    file: (path: string) => apiFetch<{ content: string; path: string }>(`${BASE}/kb/file?path=${encodeURIComponent(path)}`),
    search: (q: string) => apiFetch<{ path: string }[]>(`${BASE}/kb/search?q=${encodeURIComponent(q)}`),
  },
};

export { getToken, ensureToken };
