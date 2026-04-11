/**
 * Unit tests for useAgentFilters hook (issue #448).
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentFilters } from '../hooks/useAgentFilters';
import type { Agent } from '../api/types';

const agents: Agent[] = [
  { id: 'naruto', name: 'Naruto', status: 'online', model: 'claude-sonnet-4-6' } as Agent,
  { id: 'sasuke', name: 'Sasuke', status: 'offline', model: 'claude-haiku-4-5-20251001' } as Agent,
  { id: 'kakashi', name: 'Kakashi', status: 'online', model: 'claude-sonnet-4-6' } as Agent,
];

describe('useAgentFilters — search', () => {
  it('filters agents by name (case-insensitive)', () => {
    const { result } = renderHook(() => useAgentFilters(agents));
    act(() => { result.current.setSearch('naruto'); });
    expect(result.current.filteredAgents).toHaveLength(1);
    expect(result.current.filteredAgents[0].id).toBe('naruto');
  });

  it('filters agents by id', () => {
    const { result } = renderHook(() => useAgentFilters(agents));
    act(() => { result.current.setSearch('sas'); });
    expect(result.current.filteredAgents).toHaveLength(1);
    expect(result.current.filteredAgents[0].id).toBe('sasuke');
  });

  it('returns all agents when search is empty', () => {
    const { result } = renderHook(() => useAgentFilters(agents));
    expect(result.current.filteredAgents).toHaveLength(3);
  });
});

describe('useAgentFilters — filterBus', () => {
  it('filters to online agents only', () => {
    const { result } = renderHook(() => useAgentFilters(agents));
    act(() => { result.current.setFilterBus('online'); });
    expect(result.current.filteredAgents.every(a => a.status === 'online')).toBe(true);
    expect(result.current.filteredAgents).toHaveLength(2);
  });

  it('filters to offline agents only', () => {
    const { result } = renderHook(() => useAgentFilters(agents));
    act(() => { result.current.setFilterBus('offline'); });
    expect(result.current.filteredAgents).toHaveLength(1);
    expect(result.current.filteredAgents[0].id).toBe('sasuke');
  });
});

describe('useAgentFilters — sorting', () => {
  it('sorts by name by default', () => {
    const { result } = renderHook(() => useAgentFilters(agents));
    const names = result.current.filteredAgents.map(a => a.name);
    expect(names).toEqual([...names].sort());
  });

  it('sorts by model when sortBy=model', () => {
    const { result } = renderHook(() => useAgentFilters(agents));
    act(() => { result.current.setSortBy('model'); });
    const models = result.current.filteredAgents.map(a => a.model || '');
    expect(models).toEqual([...models].sort());
  });
});

describe('useAgentFilters — allModels', () => {
  it('returns unique models from agents', () => {
    const { result } = renderHook(() => useAgentFilters(agents));
    expect(result.current.allModels).toContain('claude-sonnet-4-6');
    expect(result.current.allModels).toContain('claude-haiku-4-5-20251001');
    expect(result.current.allModels).toHaveLength(2);
  });
});
