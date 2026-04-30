import type { Workflow, WorkItem, WorkItemFilters, Case, Run, Reminder, ReminderStatus, RoleDef, DocTemplate, RuntimeEvent, Agent, AgentStatus, Person, WorkspaceFile, KibaAction, HighlightAction, Skill, McpServerDef, ProcessMiningData, KonohaMessage, KbNode, EventWait, EventWaitStatus, AssistantWorkflowResponse, DashboardProfile } from './types';
export type { KibaAction, HighlightAction };

export interface AttachmentRef { path: string; name: string; mime?: string; }
export interface AssistantChatParams {
  message: string;
  context?: string;
  operator_state?: unknown;
  schema?: unknown;
  chat_id?: string;
  mode?: 'process' | 'admin';
  stream?: false;
  images?: Array<{ data: string; mime: string; name?: string }>;
  attachments?: AttachmentRef[];
}

/** Upload a file to /attachments, returns AttachmentRef for use in chat requests */
export async function uploadAttachment(file: File, from = 'user'): Promise<AttachmentRef> {
  const form = new FormData();
  form.append('file', file);
  form.append('from', from);
  const res = await fetch('/attachments', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`);
  const data = await res.json();
  return { path: data.attachment.path, name: data.attachment.name, mime: data.attachment.mime };
}

// Nginx injects Bearer token into /api/* automatically — no token needed from client.

// ── Simple in-memory GET cache with per-path TTL ─────────────────────────────
const _cache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL_MS = 10_000; // default 10s
// Static/rarely-changing data gets longer TTL
const CACHE_TTL_OVERRIDES: Array<[string, number]> = [
  ['/api/skills', 5 * 60_000],  // 5 min — skills change only on explicit edit
  ['/api/roles',  60_000],       // 1 min — roles change infrequently
  ['/api/people', 60_000],       // 1 min — people list changes infrequently
];

function cacheTtl(path: string): number {
  for (const [prefix, ttl] of CACHE_TTL_OVERRIDES) {
    if (path.startsWith(prefix)) return ttl;
  }
  return CACHE_TTL_MS;
}

function invalidateCache(...prefixes: string[]) {
  for (const key of _cache.keys()) {
    if (prefixes.some(prefix => key.startsWith(prefix))) _cache.delete(key);
  }
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const isFormData = options?.body instanceof FormData;
  const method = (options?.method || 'GET').toUpperCase();

  // Cache GET requests
  if (method === 'GET') {
    const cached = _cache.get(path);
    if (cached && Date.now() - cached.ts < cacheTtl(path)) {
      return cached.data as T;
    }
  } else {
    // Invalidate cache: remove entries that are prefixes of the mutated path
    // OR that start with the mutated path (sub-resources).
    // e.g., PUT /api/agents/id/avatar also invalidates /api/agents list cache.
    const base = path.split('?')[0];
    for (const key of _cache.keys()) {
      if (key.startsWith(base) || base.startsWith(key)) _cache.delete(key);
    }
  }

  const res = await fetch(path, {
    ...options,
    headers: isFormData ? (options?.headers || {}) : {
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
  const data = await res.json() as T;
  if (method === 'GET') _cache.set(path, { data, ts: Date.now() });
  return data;
}

const BASE = '/api';

type ActCategory = 'act' | 'inspect' | 'drill';

async function act<T>(action: string, args: Record<string, unknown>, category: ActCategory = 'act'): Promise<T> {
  const result = await apiFetch<{ ok: boolean; data?: T; error?: string }>(`${BASE}/act`, {
    method: 'POST',
    body: JSON.stringify({ action, category, args }),
  });
  if (!result.ok) throw new Error(result.error || `Action failed: ${action}`);
  return result.data as T;
}

async function actMutation<T>(
  action: string,
  args: Record<string, unknown>,
  invalidates: string[],
  category: ActCategory = 'act',
): Promise<T> {
  const data = await act<T>(action, args, category);
  invalidateCache(...invalidates);
  return data;
}

// ── Workflows ─────────────────────────────────────────────────────────────────

export const api = {
  auth: {
    me: () => apiFetch<{ authenticated: boolean; username: string; isAdmin: boolean; profile?: DashboardProfile }>(`${BASE}/auth/me`),
  },

  profile: {
    me: () => apiFetch<DashboardProfile>(`${BASE}/profile/me`),
    save: (p: Partial<DashboardProfile>) =>
      apiFetch<DashboardProfile>(`${BASE}/profile/me`, { method: 'PUT', body: JSON.stringify(p) }),
    generateAvatar: (params?: { style?: string; description?: string; prompt?: string }) =>
      apiFetch<{ avatar_url: string }>(`${BASE}/profile/me/avatar`, { method: 'POST', body: JSON.stringify(params || {}) }),
    uploadAvatar: (file: File) => {
      const fd = new FormData(); fd.append('file', file);
      return apiFetch<{ avatar_url: string }>(`${BASE}/profile/me/avatar`, { method: 'POST', body: fd });
    },
    generateAvatarImg2Img: (file: File, prompt: string) => {
      const fd = new FormData(); fd.append('file', file); fd.append('prompt', prompt);
      return apiFetch<{ avatar_url: string }>(`${BASE}/profile/me/avatar`, { method: 'POST', body: fd });
    },
  },

  workflows: {
    list: () => apiFetch<Workflow[]>(`${BASE}/workflows`),
    get: (id: string) => apiFetch<Workflow>(`${BASE}/workflows/${id}`),
    versions: (id: string) => apiFetch<{ version: string; saved_at?: string }[]>(`${BASE}/workflows/${id}/versions`),
    create: (body: Partial<Workflow> & { id: string; name: string }, draft = false) =>
      actMutation<Workflow>('workflow.create', { ...body, draft }, [`${BASE}/workflows`, `${BASE}/cases`, `${BASE}/workitems`]),
    update: (id: string, body: Partial<Workflow>, draft = false) =>
      actMutation<Workflow>('workflow.update', { ...body, id, draft }, [`${BASE}/workflows`, `${BASE}/cases`, `${BASE}/workitems`]),
    delete: (id: string) =>
      actMutation<{ ok: boolean }>('workflow.delete', { id }, [`${BASE}/workflows`, `${BASE}/cases`, `${BASE}/workitems`]),
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
      actMutation<WorkItem>('workitem.complete', { id, output: output || {} }, [`${BASE}/workitems`, `${BASE}/cases`]),
    create: (params: { label: string; assignee: string; deadline?: string; input?: Record<string, unknown>; process_id?: string }) =>
      actMutation<WorkItem>('workitem.create', params as Record<string, unknown>, [`${BASE}/workitems`]),
    deleteAll: () => apiFetch<{ deleted: number }>(`${BASE}/workitems/all`, { method: 'DELETE' }),
  },

  waits: {
    list: (filters?: { assignee?: string; process_id?: string; case_id?: string; status?: EventWaitStatus | '' }) => {
      const p = new URLSearchParams();
      if (filters?.assignee) p.set('assignee', filters.assignee);
      if (filters?.process_id) p.set('process_id', filters.process_id);
      if (filters?.case_id) p.set('case_id', filters.case_id);
      if (filters?.status) p.set('status', filters.status);
      const qs = p.toString();
      return apiFetch<{ waits: EventWait[]; summary: { total: number; active: number; overdue: number; escalated: number; manual: number } }>(`${BASE}/waits${qs ? '?' + qs : ''}`);
    },
    confirm: (id: string, params?: { comment?: string; confirmed_by?: string }) =>
      apiFetch<{ ok: boolean; wait_id: string; case_id: string; status: string }>(`${BASE}/waits/${id}/confirm`, {
        method: 'POST',
        body: JSON.stringify(params || {}),
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
    close: (id: string) =>
      actMutation<Case>('case.close', { id }, [`${BASE}/cases`, `${BASE}/workitems`]),
  },

  /** Alias for cases — use "прогон" terminology in new UI */
  runs: {
    list: (filters?: { status?: string; process_id?: string; limit?: number; offset?: number }) => {
      const p = new URLSearchParams();
      if (filters?.status)     p.set('status', filters.status);
      if (filters?.process_id) p.set('process_id', filters.process_id);
      if (filters?.limit)      p.set('limit', String(filters.limit));
      if (filters?.offset)     p.set('offset', String(filters.offset));
      const qs = p.toString();
      return apiFetch<{ cases: Run[]; total: number }>(`${BASE}/cases${qs ? '?' + qs : ''}`);
    },
    get: (id: string) => apiFetch<Run>(`${BASE}/cases/${id}`),
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
    list: (params?: { locale?: string; scope?: string }) => {
      const p = new URLSearchParams();
      if (params?.locale) p.set('locale', params.locale);
      if (params?.scope) p.set('scope', params.scope);
      const qs = p.toString();
      return apiFetch<Agent[]>(`${BASE}/agents${qs ? '?' + qs : ''}`);
    },
    get: (id: string, params?: { locale?: string; scope?: string }) => {
      const p = new URLSearchParams();
      if (params?.locale) p.set('locale', params.locale);
      if (params?.scope) p.set('scope', params.scope);
      const qs = p.toString();
      return apiFetch<Agent>(`${BASE}/agents/${id}${qs ? '?' + qs : ''}`);
    },
    create: (params: { id: string; name: string; display_alias?: string; system_prompt?: string; model?: string }) =>
      apiFetch<Agent>(`${BASE}/agents`, { method: 'POST', body: JSON.stringify(params) }),
    update: (id: string, patch: { name?: string; display_alias?: string; system_prompt?: string; runtime?: string; fallback_runtime?: string; model?: string; reasoning_effort?: string; capabilities?: string[]; gender?: string }) =>
      actMutation<Agent>('agent.update_profile', { id, ...patch }, [`${BASE}/agents`, `${BASE}/agents/${id}`]),
    switchRuntime: (id: string, patch: { runtime?: string; fallback_runtime?: string; model?: string; reasoning_effort?: string; restart?: boolean }) =>
      apiFetch<{ def: Agent; state?: AgentStatus | null; error?: string }>(`${BASE}/agents/${id}/switch-runtime`, { method: 'POST', body: JSON.stringify(patch) }),
    start: (id: string) => actMutation<unknown>('agent.start', { id }, [`${BASE}/agents`]),
    stop: (id: string) => actMutation<unknown>('agent.stop', { id }, [`${BASE}/agents`]),
    restart: (id: string) => actMutation<unknown>('agent.restart', { id }, [`${BASE}/agents`]),
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
    memorySave: (id: string, filename: string, content: string) =>
      apiFetch<{ ok: boolean }>(`${BASE}/agents/${id}/memory/${encodeURIComponent(filename)}`, { method: 'PUT', body: content }),
    memoryCreate: (id: string, filename: string, content: string) =>
      apiFetch<{ ok: boolean }>(`${BASE}/agents/${id}/memory/${encodeURIComponent(filename)}`, { method: 'POST', body: content }),
    generateAvatar: (id: string, params?: { style?: string; description?: string; prompt?: string }) =>
      apiFetch<{ avatar_url: string }>(`${BASE}/agents/${id}/avatar`, { method: 'POST', body: JSON.stringify(params || {}) }),
    uploadAvatar: (id: string, file: File) => {
      const fd = new FormData(); fd.append('file', file);
      return apiFetch<{ avatar_url: string }>(`${BASE}/agents/${id}/avatar`, { method: 'POST', body: fd });
    },
    generateAvatarImg2Img: (id: string, file: File, prompt: string) => {
      const fd = new FormData(); fd.append('file', file); fd.append('prompt', prompt);
      return apiFetch<{ avatar_url: string }>(`${BASE}/agents/${id}/avatar`, { method: 'POST', body: fd });
    },
  },

  roles: {
    list: () => apiFetch<RoleDef[]>(`${BASE}/roles`),
    create: (params: { role_id: string; name: string; description?: string; assignees?: string[]; strategy?: string }) =>
      actMutation<RoleDef>('role.create', params as Record<string, unknown>, [`${BASE}/roles`]),
    update: (id: string, patch: Partial<RoleDef>) =>
      actMutation<RoleDef>('role.update', { ...patch, id }, [`${BASE}/roles`]),
    delete: (id: string) => actMutation<{ ok: boolean }>('role.delete', { id }, [`${BASE}/roles`]),
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
      case_id?: string;
      process_id?: string;
      element_id?: string;
      work_item_id?: string;
    }) => actMutation<Reminder>('reminder.create', params as Record<string, unknown>, [`${BASE}/reminders`]),
    acknowledge: (id: string) =>
      actMutation<Reminder>('reminder.update_status', { id, status: 'acknowledged' }, [`${BASE}/reminders`]),
    delete: (id: string) =>
      actMutation<{ ok: boolean }>('reminder.delete', { id }, [`${BASE}/reminders`]),
  },

  messages: {
    history: (agentId: string, count = 50) =>
      apiFetch<KonohaMessage[]>(`${BASE}/messages/${agentId}/history?count=${count}`),
    send: (params: { from: string; to: string; text: string; type?: string }) =>
      apiFetch<{ id: string }>(`${BASE}/messages`, { method: 'POST', body: JSON.stringify(params) }),
  },

  people: {
    list: () => apiFetch<Person[]>(`${BASE}/people`),
    save: async (p: Partial<Person>) => {
      const saved = await act<Person>('person.upsert', p as Record<string, unknown>);
      invalidateCache(`${BASE}/people`);
      return saved;
    },
    delete: async (id: string) => {
      const deleted = await act<{ ok: boolean }>('person.delete', { id });
      invalidateCache(`${BASE}/people`);
      return deleted;
    },
    generateAvatar: (id: string, params?: { style?: string; description?: string; prompt?: string }) =>
      apiFetch<{ avatar_url: string }>(`${BASE}/people/${encodeURIComponent(id)}/avatar`, { method: 'POST', body: JSON.stringify(params || {}) }),
    uploadAvatar: (id: string, file: File) => {
      const fd = new FormData(); fd.append('file', file);
      return apiFetch<{ avatar_url: string }>(`${BASE}/people/${encodeURIComponent(id)}/avatar`, { method: 'POST', body: fd });
    },
    generateAvatarImg2Img: (id: string, file: File, prompt: string) => {
      const fd = new FormData(); fd.append('file', file); fd.append('prompt', prompt);
      return apiFetch<{ avatar_url: string }>(`${BASE}/people/${encodeURIComponent(id)}/avatar`, { method: 'POST', body: fd });
    },
  },

  health: {
    bus: () => apiFetch<{ status: string; ts: string }>(`${BASE}/health`),
  },

  kb: {
    tree: () => apiFetch<KbNode[]>(`${BASE}/kb/tree`),
    file: (path: string) => apiFetch<{ content: string; path: string }>(`${BASE}/kb/file?path=${encodeURIComponent(path)}`),
    search: (q: string) => apiFetch<{ path: string }[]>(`${BASE}/kb/search?q=${encodeURIComponent(q)}`),
  },

  assistant: {
    chat: (params: AssistantChatParams) =>
      apiFetch<AssistantWorkflowResponse>(`${BASE}/ai/chat`, {
        method: 'POST',
        body: JSON.stringify(params),
      }),
    clearChat: (chat_id: string) =>
      apiFetch<{ ok: boolean }>(`${BASE}/ai/chat/${encodeURIComponent(chat_id)}`, { method: 'DELETE' }),
  },

  tsunade: {
    /** @deprecated Compatibility shim. Use api.assistant.chat({ mode: 'process', ... }). */
    chat: (params: { message: string; schema?: unknown; chat_id?: string; attachments?: AttachmentRef[] }) =>
      apiFetch<AssistantWorkflowResponse>(`${BASE}/ai/chat`, {
        method: 'POST',
        body: JSON.stringify({ ...params, mode: 'process' }),
      }),
    clearChat: (chat_id: string) =>
      apiFetch<{ ok: boolean }>(`${BASE}/ai/chat/${encodeURIComponent(chat_id)}`, { method: 'DELETE' }),
    /** @deprecated Compatibility shim. Use api.assistant.chat({ mode: 'process', ... }). */
    processChat: (params: { message: string; schema?: unknown; chat_id?: string; attachments?: AttachmentRef[] }) =>
      apiFetch<AssistantWorkflowResponse>(`${BASE}/ai/chat`, {
        method: 'POST',
        body: JSON.stringify({ ...params, mode: 'process' }),
      }),
    clearProcessChat: (chat_id: string) =>
      apiFetch<{ ok: boolean }>(`${BASE}/ai/chat/${encodeURIComponent(chat_id)}`, { method: 'DELETE' }),
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

  eventMonitor: {
    subscriptions: (filters?: {
      process_id?: string;
      instance_id?: string;
      trigger_kind?: string;
      source?: string;
      status?: string;
    }) => {
      const p = new URLSearchParams();
      if (filters?.process_id)   p.set('process_id', filters.process_id);
      if (filters?.instance_id)  p.set('instance_id', filters.instance_id);
      if (filters?.trigger_kind) p.set('trigger_kind', filters.trigger_kind);
      if (filters?.source)       p.set('source', filters.source);
      if (filters?.status)       p.set('status', filters.status);
      const qs = p.toString();
      return apiFetch<{ subscriptions: any[]; summary: { total: number; waiting: number; fired_today: number; errors: number; manual_fallback: number } }>(
        `${BASE}/event-manager/subscriptions${qs ? '?' + qs : ''}`,
      );
    },
    history: (filters?: {
      process_id?: string;
      instance_id?: string;
      since?: string;
      until?: string;
      limit?: number;
    }) => {
      const p = new URLSearchParams();
      if (filters?.process_id) p.set('process_id', filters.process_id);
      if (filters?.instance_id) p.set('instance_id', filters.instance_id);
      if (filters?.since)      p.set('since', filters.since);
      if (filters?.until)      p.set('until', filters.until);
      if (filters?.limit)      p.set('limit', String(filters.limit));
      const qs = p.toString();
      return apiFetch<{ history: any[]; total: number }>(
        `${BASE}/event-manager/history${qs ? '?' + qs : ''}`,
      );
    },
    adaptersStatus: () =>
      apiFetch<{ adapters: any[] }>(`${BASE}/event-manager/adapters/status`),
  },

  skills: {
    list: () => apiFetch<Skill[]>(`${BASE}/skills`),
    create: (params: { id?: string; name: string; name_en?: string; description?: string; prompt_snippet?: string; tools?: string[]; mcp_servers?: McpServerDef[] }) =>
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

  whitelist: {
    get: () => apiFetch<any>(`${BASE}/whitelist`),
    approve: async (body: { type: string; telegram_id?: number; chat_id?: number }) => {
      const res = await act<{ ok: boolean; state?: any }>('access.approve', body as Record<string, unknown>);
      invalidateCache(`${BASE}/whitelist`);
      return res;
    },
    reject: async (body: { type: string; telegram_id?: number; chat_id?: number; block?: boolean }) => {
      const res = await act<{ ok: boolean; state?: any }>('access.reject', body as Record<string, unknown>);
      invalidateCache(`${BASE}/whitelist`);
      return res;
    },
    upsertUser: async (body: { name: string; telegram_id: number; username?: string; email?: string; phone?: string; position?: string; relation?: string; level?: number }) => {
      const res = await act<{ ok: boolean; state?: any }>('access.upsert_user', body as Record<string, unknown>);
      invalidateCache(`${BASE}/whitelist`, `${BASE}/people`);
      return res;
    },
    addGroup: async (body: { chat_id: number }) => {
      const res = await act<{ ok: boolean; state?: any }>('access.add_group', body as Record<string, unknown>);
      invalidateCache(`${BASE}/whitelist`);
      return res;
    },
    deleteUser: async (telegram_id: number) => {
      const res = await act<{ ok: boolean; state?: any }>('access.remove_user', { telegram_id });
      invalidateCache(`${BASE}/whitelist`, `${BASE}/people`);
      return res;
    },
    deleteGroup: async (chat_id: number) => {
      const res = await act<{ ok: boolean; state?: any }>('access.remove_group', { chat_id });
      invalidateCache(`${BASE}/whitelist`);
      return res;
    },
  },
};
