/**
 * Data hook for EventMonitor page.
 * Manages subscriptions, adapters, filters, and polling.
 * Extracted from EventMonitor.tsx (issue #448).
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { useInterval } from './useApi';
import { api } from '../api/client';
import type { Subscription, Summary, AdapterStatus, Tab } from '../pages/eventMonitorUtils';

export interface UseEventMonitorResult {
  subs: Subscription[];
  summary: Summary;
  adapters: AdapterStatus[];
  loading: boolean;
  error: string | null;
  lastUpdate: string;
  tab: Tab;
  setTab: (t: Tab) => void;
  filterKind: string;
  setFilterKind: (v: string) => void;
  filterSource: string;
  setFilterSource: (v: string) => void;
  filterProcess: string;
  setFilterProcess: (v: string) => void;
  filterStatus: string;
  setFilterStatus: (v: string) => void;
  processes: string[];
  resetFilters: () => void;
  updateUrl: (updates: Record<string, string>) => void;
}

export function useEventMonitor(): UseEventMonitorResult {
  const [tab, setTab] = useState<Tab>('timeline');
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, waiting: 0, fired_today: 0, errors: 0, manual_fallback: 0 });
  const [adapters, setAdapters] = useState<AdapterStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState('');
  const [filterKind, setFilterKind] = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [filterProcess, setFilterProcess] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // Sync filters from URL on mount
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('kind')) setFilterKind(p.get('kind')!);
    if (p.get('source')) setFilterSource(p.get('source')!);
    if (p.get('process')) setFilterProcess(p.get('process')!);
    if (p.get('status')) setFilterStatus(p.get('status')!);
    if (p.get('tab')) setTab(p.get('tab') as Tab);
  }, []);

  function updateUrl(updates: Record<string, string>) {
    const p = new URLSearchParams(window.location.search);
    Object.entries(updates).forEach(([k, v]) => v ? p.set(k, v) : p.delete(k));
    window.history.replaceState({}, '', '?' + p.toString());
  }

  const load = useCallback(async () => {
    try {
      const [subsRes, adaptersRes] = await Promise.all([
        api.eventMonitor.subscriptions({
          trigger_kind: filterKind || undefined,
          source: filterSource || undefined,
          process_id: filterProcess || undefined,
          status: filterStatus || undefined,
        }),
        api.eventMonitor.adaptersStatus().catch(() => ({ adapters: [] })),
      ]);
      setSubs(subsRes.subscriptions);
      setSummary(subsRes.summary);
      setAdapters(adaptersRes.adapters);
      setLastUpdate(new Date().toLocaleTimeString('ru-RU'));
      setError(null);
      setLoading(false);
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  }, [filterKind, filterSource, filterProcess, filterStatus]);

  useInterval(load, 30000);

  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) { initialized.current = true; load(); }
  }, [load]);

  useEffect(() => { load(); }, [filterKind, filterSource, filterProcess, filterStatus]);

  function resetFilters() {
    setFilterKind('');
    setFilterSource('');
    setFilterProcess('');
    setFilterStatus('');
    updateUrl({ kind: '', source: '', process: '', status: '' });
  }

  const processes = Array.from(new Set(subs.map(s => s.process_id))).filter(Boolean);

  return {
    subs, summary, adapters, loading, error, lastUpdate,
    tab, setTab,
    filterKind, setFilterKind,
    filterSource, setFilterSource,
    filterProcess, setFilterProcess,
    filterStatus, setFilterStatus,
    processes, resetFilters, updateUrl,
  };
}
