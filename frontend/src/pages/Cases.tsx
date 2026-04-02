import { useState, useEffect, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { StatusBadge } from '../components/StatusBadge';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { Case, Workflow } from '../api/types';

const styles = `
  .cs-body { padding: 20px; }
  .container { max-width: 1400px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .page-header h1 { color: #333; font-size: 24px; }
  .filters { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #eee; }
  .filters select, .filters input { padding: 7px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
  .filters button { padding: 7px 14px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
  .filters button.reset { background: #999; }
  .table { width: 100%; border-collapse: collapse; }
  .table th { background: #f9f9f9; padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #666; border-bottom: 2px solid #eee; text-transform: uppercase; }
  .table td { padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; }
  .table tr:hover td { background: #fafafa; cursor: pointer; }
  .link { color: #0066cc; text-decoration: none; cursor: pointer; font-weight: 500; }
  .link:hover { text-decoration: underline; }
  .mono { font-family: monospace; font-size: 12px; color: #555; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }
  .pagination { display: flex; gap: 8px; margin-top: 16px; align-items: center; font-size: 14px; color: #666; }
  .pagination button { padding: 6px 12px; border: 1px solid #ddd; background: white; border-radius: 4px; cursor: pointer; }
  .pagination button:disabled { opacity: .4; cursor: default; }
  .refresh-info { font-size: 12px; color: #999; margin-top: 12px; text-align: right; }
  /* Detail overlay */
  .detail-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.45); z-index: 1000; display: flex; justify-content: flex-end; }
  .detail-panel { background: white; width: 560px; max-width: 95vw; overflow-y: auto; padding: 24px; box-shadow: -4px 0 20px rgba(0,0,0,.15); }
  .detail-panel h2 { font-size: 18px; margin-bottom: 4px; }
  .detail-panel .sub { font-size: 12px; color: #888; margin-bottom: 20px; }
  .detail-close { float: right; background: none; border: none; font-size: 20px; cursor: pointer; color: #999; }
  .detail-close:hover { color: #333; }
  .section-title { font-size: 12px; font-weight: 700; color: #666; text-transform: uppercase; margin: 16px 0 8px; border-top: 1px solid #eee; padding-top: 12px; }
  .timeline-item { display: flex; gap: 12px; margin-bottom: 10px; font-size: 13px; }
  .timeline-dot { width: 10px; height: 10px; border-radius: 50%; background: #10b981; flex-shrink: 0; margin-top: 3px; }
  .timeline-dot.active { background: #3b82f6; }
  .timeline-dot.error { background: #ef4444; }
  .timeline-meta { color: #888; font-size: 11px; margin-top: 2px; }
  .payload-code { background: #f5f5f5; padding: 8px; border-radius: 3px; font-size: 11px; font-family: monospace; overflow-x: auto; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; }
`;

const PAGE_SIZE = 20;

export function Cases() {
  const token = useToken();
  const [cases, setCases] = useState<Case[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState('-');
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [processFilter, setProcessFilter] = useState('');
  const [appliedFilters, setAppliedFilters] = useState({ status: '', process_id: '' });
  const [selectedCase, setSelectedCase] = useState<Case | null>(null);
  const [wfNameMap, setWfNameMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!token) return;
    api.workflows.list().then(wfs => {
      const m: Record<string, string> = {};
      wfs.forEach((wf: Workflow) => { m[wf.id] = wf.name || wf.id; });
      setWfNameMap(m);
    }).catch(() => {});
  }, [token]);

  const load = useCallback(() => {
    if (!token) return;
    const filters: Record<string, unknown> = { limit: PAGE_SIZE, offset };
    if (appliedFilters.status)     filters.status = appliedFilters.status;
    if (appliedFilters.process_id) filters.process_id = appliedFilters.process_id;
    api.cases.list(filters as any)
      .then(res => {
        setCases(res.cases);
        setTotal(res.total);
        setLastUpdate(new Date().toLocaleTimeString());
        setError(null);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token, offset, appliedFilters]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 15000);

  function applyFilters() {
    setOffset(0);
    setAppliedFilters({ status: statusFilter, process_id: processFilter });
  }
  function resetFilters() {
    setStatusFilter(''); setProcessFilter('');
    setOffset(0);
    setAppliedFilters({ status: '', process_id: '' });
  }

  async function openDetail(c: Case) {
    // Refresh case detail
    try {
      const fresh = await api.cases.get(c.case_id);
      setSelectedCase(fresh);
    } catch { setSelectedCase(c); }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <Layout activePage="cases.html">
      <style>{styles}</style>
      <div className="cs-body">
        <div className="container">
          <div className="page-header"><h1>Cases</h1></div>
          {error && <div className="error-banner">{error}</div>}

          <div className="filters">
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              <option value="running">Running</option>
              <option value="done">Done</option>
              <option value="error">Error</option>
            </select>
            <input type="text" placeholder="Filter by process ID..."
              value={processFilter} onChange={e => setProcessFilter(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applyFilters()} />
            <button onClick={applyFilters}>Apply</button>
            <button className="reset" onClick={resetFilters}>Reset</button>
          </div>

          {loading && <div className="empty">Loading...</div>}
          {!loading && cases.length === 0 && <div className="empty">No cases found.</div>}

          {cases.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Process</th>
                  <th>Status</th>
                  <th>Position</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {cases.map(c => (
                  <tr key={c.case_id} onClick={() => openDetail(c)}>
                    <td><span className="link">{c.subject || '(no subject)'}</span></td>
                    <td>{wfNameMap[c.process_id] || c.process_id}</td>
                    <td><StatusBadge status={c.status} /></td>
                    <td className="mono">{c.position || '-'}</td>
                    <td>{new Date(c.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {total > PAGE_SIZE && (
            <div className="pagination">
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>← Prev</button>
              <span>Page {currentPage} of {totalPages} ({total} total)</span>
              <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next →</button>
            </div>
          )}

          <div className="refresh-info">Auto-refresh 15s • Last: {lastUpdate}</div>
        </div>
      </div>

      {selectedCase && (
        <div className="detail-overlay" onClick={e => { if (e.target === e.currentTarget) setSelectedCase(null); }}>
          <div className="detail-panel">
            <button className="detail-close" onClick={() => setSelectedCase(null)}>✕</button>
            <h2>{selectedCase.subject}</h2>
            <div className="sub">
              {wfNameMap[selectedCase.process_id] || selectedCase.process_id} •{' '}
              <span className="mono">{selectedCase.case_id.substring(0, 8)}</span> •{' '}
              <StatusBadge status={selectedCase.status} />
            </div>

            <div className="section-title">Payload</div>
            <pre className="payload-code">{JSON.stringify(selectedCase.payload, null, 2)}</pre>

            <div className="section-title">Timeline ({selectedCase.history?.length || 0} steps)</div>
            {(selectedCase.history || []).map((h, i) => (
              <div className="timeline-item" key={i}>
                <div className={`timeline-dot${i === (selectedCase.history.length - 1) ? ' active' : ''}`} />
                <div>
                  <div><strong>{h.label}</strong> <span style={{ color: '#888', fontSize: 11 }}>({h.element_type})</span></div>
                  <div className="timeline-meta">{new Date(h.timestamp).toLocaleString()}</div>
                  {h.output && Object.keys(h.output).length > 0 && (
                    <pre className="payload-code" style={{ marginTop: 4 }}>{JSON.stringify(h.output, null, 2)}</pre>
                  )}
                </div>
              </div>
            ))}
            {(!selectedCase.history || selectedCase.history.length === 0) && (
              <div style={{ color: '#999', fontSize: 13 }}>No history yet.</div>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}
