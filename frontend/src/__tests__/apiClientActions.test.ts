import { afterEach, describe, expect, test, vi } from 'vitest';
import { api } from '../api/client';

function mockActionResponse(data: unknown = {}) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function lastAction(fetchMock: ReturnType<typeof vi.fn>) {
  const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
  return JSON.parse(String((init as RequestInit).body));
}

describe('api client action mutations', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test.each([
    ['workflow.create', () => api.workflows.create({ id: 'wf', name: 'Workflow', elements: [], flow: [] })],
    ['workflow.update', () => api.workflows.update('wf', { name: 'Updated' })],
    ['workflow.delete', () => api.workflows.delete('wf')],
    ['workitem.create', () => api.workitems.create({ label: 'Task', assignee: 'naruto' })],
    ['workitem.complete', () => api.workitems.complete('wi-1')],
    ['case.close', () => api.cases.close('case-1')],
    ['agent.start', () => api.agents.start('naruto')],
    ['agent.stop', () => api.agents.stop('naruto')],
    ['agent.restart', () => api.agents.restart('naruto')],
    ['role.create', () => api.roles.create({ role_id: 'role', name: 'Role' })],
    ['role.update', () => api.roles.update('role', { name: 'Updated' })],
    ['role.delete', () => api.roles.delete('role')],
    ['reminder.create', () => api.reminders.create({ recipient: 'naruto', message: 'Ping', scheduled_at: '2030-01-01T00:00:00.000Z' })],
    ['reminder.update_status', () => api.reminders.acknowledge('reminder-1')],
    ['reminder.delete', () => api.reminders.delete('reminder-1')],
  ])('%s uses /api/act', async (action, callApi) => {
    const fetchMock = mockActionResponse({});

    await callApi();

    expect(fetchMock).toHaveBeenLastCalledWith('/api/act', expect.objectContaining({ method: 'POST' }));
    expect(lastAction(fetchMock).action).toBe(action);
  });
});
