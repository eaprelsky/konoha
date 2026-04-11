/**
 * Unit tests for useAgents hook (issue #448).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAgents } from '../hooks/useAgents';

vi.mock('../context/TokenContext', () => ({
  useToken: () => 'test-token',
}));

vi.mock('../hooks/useApi', () => ({
  useInterval: vi.fn(),
}));

const mockAgents = [
  { id: 'naruto', name: 'Naruto', status: 'online', model: 'claude-sonnet-4-6' },
  { id: 'sasuke', name: 'Sasuke', status: 'offline', model: 'claude-haiku-4-5-20251001' },
];

vi.mock('../api/client', () => ({
  api: {
    agents: {
      list: vi.fn(),
    },
  },
}));

import { api } from '../api/client';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useAgents', () => {
  it('returns agents from API on successful fetch', async () => {
    (api.agents.list as any).mockResolvedValue(mockAgents);
    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.agents).toEqual(mockAgents);
    expect(result.current.error).toBeNull();
  });

  it('sets error state when API call fails', async () => {
    (api.agents.list as any).mockRejectedValue(new Error('Network error'));
    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Network error');
    expect(result.current.agents).toEqual([]);
  });

  it('updates lastUpdate timestamp after successful load', async () => {
    (api.agents.list as any).mockResolvedValue(mockAgents);
    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.lastUpdate).not.toBe('-');
  });

  it('exposes a load function that re-fetches agents', async () => {
    (api.agents.list as any).mockResolvedValue(mockAgents);
    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const callCount = (api.agents.list as any).mock.calls.length;
    act(() => { result.current.load(); });
    await waitFor(() => expect((api.agents.list as any).mock.calls.length).toBeGreaterThan(callCount));
  });
});
