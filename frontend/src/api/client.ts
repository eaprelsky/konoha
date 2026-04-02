import type { Workflow, WorkItem, WorkItemFilters, Case } from './types';

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

// ── Workflows ─────────────────────────────────────────────────────────────────

export const api = {
  workflows: {
    list: () => apiFetch<Workflow[]>('/workflows'),
    get: (id: string) => apiFetch<Workflow>(`/workflows/${id}`),
  },

  workitems: {
    list: (filters?: WorkItemFilters) => {
      const p = new URLSearchParams();
      if (filters?.assignee)       p.set('assignee', filters.assignee);
      if (filters?.process_id)     p.set('process_id', filters.process_id);
      if (filters?.status)         p.set('status', filters.status);
      if (filters?.deadline_before) p.set('deadline_before', filters.deadline_before);
      const qs = p.toString();
      return apiFetch<WorkItem[]>(`/workitems${qs ? '?' + qs : ''}`);
    },
    complete: (id: string, output?: Record<string, unknown>) =>
      apiFetch<WorkItem>(`/workitems/${id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ output: output || {} }),
      }),
  },

  cases: {
    get: (id: string) => apiFetch<Case>(`/cases/${id}`),
  },
};

export { getToken, ensureToken };
