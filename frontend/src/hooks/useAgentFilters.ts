import { useState, useMemo } from 'react';
import type { Agent } from '../api/types';

export type SortBy = 'name' | 'status' | 'model';

export interface UseAgentFiltersResult {
  search: string;
  setSearch: (v: string) => void;
  filterBus: string;
  setFilterBus: (v: string) => void;
  filterLifecycle: string;
  setFilterLifecycle: (v: string) => void;
  filterModel: string;
  setFilterModel: (v: string) => void;
  sortBy: SortBy;
  setSortBy: (v: SortBy) => void;
  filteredAgents: Agent[];
  allModels: string[];
}

export function useAgentFilters(agents: Agent[]): UseAgentFiltersResult {
  const [search, setSearch] = useState('');
  const [filterBus, setFilterBus] = useState('all');
  const [filterLifecycle, setFilterLifecycle] = useState('all');
  const [filterModel, setFilterModel] = useState('all');
  const [sortBy, setSortBy] = useState<SortBy>('name');

  const allModels = useMemo(
    () => [...new Set(agents.map(a => a.model).filter(Boolean))] as string[],
    [agents]
  );

  const filteredAgents = useMemo(() => agents
    .filter(a => {
      const q = search.toLowerCase();
      const displayAlias = (a.display_alias || '').toLowerCase();
      if (search && !a.name.toLowerCase().includes(q) && !displayAlias.includes(q) && !a.id.toLowerCase().includes(q)) return false;
      if (filterBus !== 'all' && a.status !== filterBus) return false;
      if (filterLifecycle !== 'all') {
        const ls = (a.lifecycle as any)?.status;
        if (filterLifecycle === 'none' ? ls : ls !== filterLifecycle) return false;
      }
      if (filterModel !== 'all' && a.model !== filterModel) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'name') return (a.display_alias || a.name).localeCompare(b.display_alias || b.name);
      if (sortBy === 'model') return (a.model || '').localeCompare(b.model || '');
      if (sortBy === 'status') return a.status.localeCompare(b.status);
      return 0;
    }),
    [agents, search, filterBus, filterLifecycle, filterModel, sortBy]
  );

  return { search, setSearch, filterBus, setFilterBus, filterLifecycle, setFilterLifecycle, filterModel, setFilterModel, sortBy, setSortBy, filteredAgents, allModels };
}
