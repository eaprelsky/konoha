import { afterEach, describe, expect, test, vi } from 'vitest';

type ApiClient = typeof import('../api/client').api;

const originalFetch = globalThis.fetch;

function mockActionResponse(data: unknown = {}) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function lastAction(fetchMock: ReturnType<typeof vi.fn>) {
  const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
  return JSON.parse(String((init as RequestInit).body));
}

async function loadApi(): Promise<ApiClient> {
  // Bun's vitest shim keeps vi.mock() state across test files; a query suffix
  // forces this test to import the real API client instead of a sibling mock.
  const mod = await import(`../api/client.ts?apiClientActions=${Date.now()}-${Math.random()}`);
  return mod.api as ApiClient;
}

describe('api client action mutations', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test.each([
    ['workflow.create', (api: ApiClient) => api.workflows.create({ id: 'wf', name: 'Workflow', elements: [], flow: [] })],
    ['workflow.update', (api: ApiClient) => api.workflows.update('wf', { name: 'Updated' })],
    ['workflow.delete', (api: ApiClient) => api.workflows.delete('wf')],
    ['workitem.create', (api: ApiClient) => api.workitems.create({ label: 'Task', assignee: 'operator' })],
    ['workitem.complete', (api: ApiClient) => api.workitems.complete('wi-1')],
    ['case.close', (api: ApiClient) => api.cases.close('case-1')],
    ['agent.start', (api: ApiClient) => api.agents.start('agent-1')],
    ['agent.stop', (api: ApiClient) => api.agents.stop('agent-1')],
    ['agent.restart', (api: ApiClient) => api.agents.restart('agent-1')],
    ['role.create', (api: ApiClient) => api.roles.create({ role_id: 'role', name: 'Role' })],
    ['role.update', (api: ApiClient) => api.roles.update('role', { name: 'Updated' })],
    ['role.delete', (api: ApiClient) => api.roles.delete('role')],
    ['reminder.create', (api: ApiClient) => api.reminders.create({ recipient: 'operator', message: 'Ping', scheduled_at: '2030-01-01T00:00:00.000Z' })],
    ['reminder.update_status', (api: ApiClient) => api.reminders.acknowledge('reminder-1')],
    ['reminder.delete', (api: ApiClient) => api.reminders.delete('reminder-1')],
  ])('%s uses /api/act', async (action, callApi) => {
    const fetchMock = mockActionResponse({});
    const api = await loadApi();

    await callApi(api);

    expect(fetchMock).toHaveBeenLastCalledWith('/api/act', expect.objectContaining({ method: 'POST' }));
    expect(lastAction(fetchMock).action).toBe(action);
  });
});
