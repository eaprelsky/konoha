import { useState, useCallback, useEffect } from 'react';
import { useToken } from '../context/TokenContext';
import { useInterval } from './useApi';
import { api } from '../api/client';
import type { Agent } from '../api/types';

export interface UseAgentsResult {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  lastUpdate: string;
  load: () => void;
}

export function useAgents(intervalMs = 10000): UseAgentsResult {
  const token = useToken();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState('-');

  const load = useCallback(() => {
    if (!token) return;
    api.agents.list()
      .then(data => {
        setAgents(data);
        setLastUpdate(new Date().toLocaleTimeString());
        setError(null);
        setLoading(false);
      })
      .catch(e => {
        setError(e.message);
        setLoading(false);
      });
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, intervalMs);

  return { agents, loading, error, lastUpdate, load };
}
