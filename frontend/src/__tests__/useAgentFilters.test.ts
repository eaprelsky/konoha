/**
 * Unit tests for useAgentFilters hook (issue #448).
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentFilters } from '../hooks/useAgentFilters';
import type { Agent } from '../api/types';

const agents: Agent[] = [
  { id: 'advisor', name: 'Advisor', status: 'online', model: 'claude-sonnet-4-6', lifecycle_mode: 'core' } as Agent,
  { id: 'telegram-bot', name: 'Telegram bot', status: 'online', model: 'claude-sonnet-4-6', seed_classification: 'connector_owned' } as Agent,
  { id: 'qa-worker', name: 'QA worker', status: 'offline', model: 'claude-haiku-4-5-20251001', lifecycle_mode: 'optional_on_demand' } as Agent,
  { id: 'legacy-writer', name: 'Legacy writer', status: 'offline', model: 'claude-haiku-4-5-20251001', lifecycle_mode: 'deprecated' } as Agent,
  { id: 'vendor-agent', name: 'Vendor agent', status: 'online', model: 'claude-sonnet-4-6', village_id: 'partner.example' } as Agent,
];

describe('useAgentFilters — search', () => {
  it('filters agents by name (case-insensitive)', () => {
    const { result } = renderHook(() => useAgentFilters(agents));
    act(() => { result.current.setSearch('advisor'); });
    expect(result.current.filteredAgents).toHaveLength(1);
    expect(result.current.filteredAgents[0].id).toBe('advisor');
  });

  it('filters agents by id', () => {
    const { result } = renderHook(() => useAgentFilters(agents));
    act(() => { result.current.setSearch('qa-'); });
    expect(result.current.filteredAgents).toHaveLength(1);
    expect(result.current.filteredAgents[0].id).toBe('qa-worker');
  });

  it('returns all agents when search is empty', () => {
    const { result } = renderHook(() => useAgentFilters(agents));
    expect(result.current.filteredAgents).toHaveLength(5);
  });
});

describe('useAgentFilters — filterBus', () => {
  it('filters to online agents only', () => {
    const { result } = renderHook(() => useAgentFilters(agents));
    act(() => { result.current.setFilterBus('online'); });
    expect(result.current.filteredAgents.every(a => a.status === 'online')).toBe(true);
    expect(result.current.filteredAgents).toHaveLength(3);
  });

  it('filters to offline agents only', () => {
    const { result } = renderHook(() => useAgentFilters(agents));
    act(() => { result.current.setFilterBus('offline'); });
    expect(result.current.filteredAgents).toHaveLength(2);
    expect(result.current.filteredAgents.map(a => a.id).sort()).toEqual(['legacy-writer', 'qa-worker']);
  });
});

describe('useAgentFilters — lifecycle class', () => {
  it.each([
    ['core', ['advisor']],
    ['connector', ['telegram-bot']],
    ['optional', ['qa-worker']],
    ['deprecated', ['legacy-writer']],
    ['external', ['vendor-agent']],
  ] as const)('filters %s agents without runtime-id allowlists', (filter, expectedIds) => {
    const { result } = renderHook(() => useAgentFilters(agents));
    act(() => { result.current.setFilterClass(filter); });
    expect(result.current.filteredAgents.map(a => a.id)).toEqual(expectedIds);
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
