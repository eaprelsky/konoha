import { useState, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { RuntimeEvent } from '../api/types';

const EVENT_TYPES = [
  'case.created', 'case.completed', 'case.error',
  'step.started', 'step.completed', 'step.failed',
  'gateway.evaluated', 'assignment', 'timeout', 'message_sent',
];

const styles = `
  .el-body { padding: 20px; }
  .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .page-header h1 { color: #333; font-size: 24px; }
  .filters { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #eee; }
  .filters select, .filters input { padding: 7px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
  .filters button { padding: 7px 14px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
  .filters button.reset { background: #999; }
  .log-list { display: flex; flex-direction: column; gap: 4px; }
  .log-item { display: grid; grid-template-columns: 160px 180px 1fr; gap: 12px; padding: 8px 12px; border-radius: 4px; font-size: 13px; border-left: 3px solid #e2e8f0; }
  .log-item:hover { background: #f8fafc; }
  .log-item.case { border-left-color: #6366f1; }
  .log-item.step { border-left-color: #10b981; }
  .log-item.gateway { border-left-color: #f59e0b; }
  .log-item.error { border-left-color: #ef4444; }
  .log-time { color: #64748b; font-family: monospace; font-size: 12px; }
  .log-type { font-weight: 600; color: #374151; }
  .log-details { color: #555; }
  .log-details .mono { font-family: monospace; font-size: 11px; color: #888; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }
  .refresh-info { font-size: 12px; color: #999; margin-top: 12px; text-align: right; }
  .count-badge { font-size: 12px; color: #888; margin-left: 8px; font-weight: normal; }
`;

function eventClass(type: string): string {
  if (type.startsWith('case.')) return 'case';
  if (type.startsWith('step.')) return 'step';
  if (type.startsWith('gateway.')) return 'gateway';
  if (type.includes('error') || type.includes('failed')) return 'error';
  return '';
}

export function EventLog() {
  const token = useToken();
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState('-');
  const [typeFilter, setTypeFilter] = useState('');
  const [appliedType, setAppliedType] = useState('');
  const [limit, setLimit] = useState(100);

  const load = useCallback(() => {
    if (!token) return;
    api.events.list({ type: appliedType || undefined, limit })
      .then(data => {
        setEvents(data);
        setLastUpdate(new Date().toLocaleTimeString());
        setError(null);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token, appliedType, limit]);

  useInterval(load, 10000);
  // initial load via useInterval would be delayed; trigger manually
  useState(() => { setTimeout(load, 0); });

  return (
    <Layout activePage="eventlog.html">
      <style>{styles}</style>
      <div className="el-body">
        <div className="container">
          <div className="page-header">
            <h1>Event Log <span className="count-badge">{events.length} events</span></h1>
          </div>
          {error && <div className="error-banner">{error}</div>}

          <div className="filters">
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
              <option value="">All event types</option>
              {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={limit} onChange={e => setLimit(Number(e.target.value))}>
              <option value={50}>Last 50</option>
              <option value={100}>Last 100</option>
              <option value={500}>Last 500</option>
            </select>
            <button onClick={() => setAppliedType(typeFilter)}>Apply</button>
            <button className="reset" onClick={() => { setTypeFilter(''); setAppliedType(''); }}>Reset</button>
          </div>

          {loading && <div className="empty">Loading...</div>}
          {!loading && events.length === 0 && <div className="empty">No events found.</div>}

          {events.length > 0 && (
            <div className="log-list">
              {[...events].reverse().map((e, i) => (
                <div key={e.id || i} className={`log-item ${eventClass(e.type)}`}>
                  <div className="log-time">{new Date(e.timestamp).toLocaleString()}</div>
                  <div className="log-type">{e.type}</div>
                  <div className="log-details">
                    {e.label && <span>{e.label} </span>}
                    {e.process_id && <span className="mono">[{e.process_id}] </span>}
                    {e.case_id && <span className="mono">case:{e.case_id.substring(0, 8)}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="refresh-info">Auto-refresh 10s • Last: {lastUpdate}</div>
        </div>
      </div>
    </Layout>
  );
}
