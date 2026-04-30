import { useState, useEffect, useCallback, useMemo } from 'react';
import { StatusBadge } from '../components/StatusBadge';
import { RunOverlay } from '../components/RunOverlay';
import { useToken } from '../context/TokenContext';
import { useI18n } from '../context/I18nContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { Case, Workflow } from '../api/types';
import { filterOperatorCases, isWorkflowHiddenFromOperator, useOperatorViewMode } from '../utils/operatorView';

type ViewMode = 'flat' | 'grouped';

interface ProcessGroup {
  process_id: string;
  process_name: string;
  cases: Case[];
  counts: { running: number; done: number; error: number; total: number };
}

const styles = `
  .cs-body { padding: 20px; }
  .container { max-width: 1400px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .page-header h1 { color: #333; font-size: 24px; }
  .filters { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #eee; }
  .filters select, .filters input { padding: 7px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
  .filters button { padding: 7px 14px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
  .filters button.reset { background: #999; }
  .view-toggle { display: flex; gap: 4px; margin-left: auto; }
  .view-toggle button { padding: 6px 12px; border: 1px solid #ddd; background: white; border-radius: 4px; cursor: pointer; font-size: 12px; color: #555; }
  .view-toggle button.active { background: #0f172a; color: white; border-color: #0f172a; }
  .hidden-toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #64748b; }
  /* Group rows */
  .group-row td { background: #f8fafc; font-weight: 600; cursor: pointer; }
  .group-row:hover td { background: #f1f5f9; }
  .group-row .group-arrow { font-size: 10px; margin-right: 6px; display: inline-block; transition: transform .15s; }
  .group-row .group-arrow.open { transform: rotate(90deg); }
  .group-count { display: inline-flex; gap: 6px; margin-left: 10px; font-weight: 400; font-size: 12px; }
  .gc-running { color: #2563eb; }
  .gc-done { color: #16a34a; }
  .gc-error { color: #dc2626; }
  .child-row td { padding-left: 28px; }
  .table { width: 100%; border-collapse: collapse; }
  .table th { background: #f9f9f9; padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #666; border-bottom: 2px solid #eee; text-transform: uppercase; }
  .table td { padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; vertical-align: middle; }
  .table tr:hover td { background: #f8fafc; cursor: pointer; }
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
  .btn-schema { display:inline-flex;align-items:center;gap:5px;padding:6px 14px;background:#0f172a;color:#f8fafc;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;margin-bottom:16px; }
  .btn-schema:hover { background:#1e293b; }
  .btn-open-schema { background:none;border:1px solid #e2e8f0;color:#0066cc;padding:3px 8px;border-radius:4px;font-size:11px;cursor:pointer;white-space:nowrap; }
  .btn-open-schema:hover { background:#f0f7ff; }
  /* Mobile card view (#358) */
  @media (max-width: 767px) {
    .table thead { display: none; }
    .table tr { display: block; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 10px; padding: 12px; cursor: pointer; }
    .table td { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; border: none; font-size: 13px; }
    .table tr:hover td { background: transparent; }
  }
`;

const PAGE_SIZE = 20;
const GROUP_LIMIT = 500;

export function Cases() {
  const token = useToken();
  const { t } = useI18n();
  const { showHiddenArtifacts, setShowHiddenArtifacts } = useOperatorViewMode();
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
  const [runCaseId, setRunCaseId] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [wfNameMap, setWfNameMap] = useState<Record<string, string>>({});
  const [wfElementMap, setWfElementMap] = useState<Record<string, Record<string, string>>>({});
  const [viewMode, setViewMode] = useState<ViewMode>('grouped');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!token) return;
    api.workflows.list().then(wfs => {
      setWorkflows(wfs);
      const m: Record<string, string> = {};
      const em: Record<string, Record<string, string>> = {};
      wfs.forEach((wf: Workflow) => {
        m[wf.id] = wf.name || wf.id;
        em[wf.id] = {};
        wf.elements?.forEach(el => { em[wf.id][el.id] = el.label; });
      });
      setWfNameMap(m);
      setWfElementMap(em);
    }).catch(() => {});
  }, [token]);

  function positionLabel(c: Case): string {
    if (!c.position) return '-';
    return wfElementMap[c.process_id]?.[c.position] ?? c.position;
  }

  function buildGroups(list: Case[]): ProcessGroup[] {
    const map = new Map<string, Case[]>();
    list.forEach(c => {
      const arr = map.get(c.process_id) ?? [];
      arr.push(c);
      map.set(c.process_id, arr);
    });
    return Array.from(map.entries()).map(([pid, cs]) => ({
      process_id: pid,
      process_name: wfNameMap[pid] || pid,
      cases: cs,
      counts: {
        total: cs.length,
        running: cs.filter(c => c.status === 'running').length,
        done: cs.filter(c => c.status === 'done').length,
        error: cs.filter(c => c.status === 'error').length,
      },
    }));
  }

  function toggleGroup(pid: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });
  }

  const load = useCallback(() => {
    if (!token) return;
    const isGrouped = viewMode === 'grouped';
    const filters: Record<string, unknown> = {
      limit: isGrouped ? GROUP_LIMIT : PAGE_SIZE,
      offset: isGrouped ? 0 : offset,
    };
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
  }, [token, offset, appliedFilters, viewMode]);

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
  const hiddenProcessIds = useMemo(
    () => new Set(workflows.filter(isWorkflowHiddenFromOperator).map(wf => wf.id)),
    [workflows],
  );
  const visibleCases = filterOperatorCases(cases, hiddenProcessIds, { showHiddenArtifacts });
  const hiddenCaseCount = cases.length - filterOperatorCases(cases, hiddenProcessIds).length;

  return (
    <>
      <style>{styles}</style>
      <div className="cs-body">
        <div className="container">
          <div className="page-header"><h1>{t('operator.runs.title')}</h1></div>
          {error && <div className="error-banner">{error}</div>}

          <div className="filters">
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">{t('operator.runs.allStatuses')}</option>
              <option value="running">{t('operator.runs.statusRunning')}</option>
              <option value="done">{t('operator.runs.statusDone')}</option>
              <option value="error">{t('operator.runs.statusError')}</option>
            </select>
            <input type="text" placeholder={t('operator.runs.filterProcess')}
              value={processFilter} onChange={e => setProcessFilter(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applyFilters()} />
            <button onClick={applyFilters}>{t('action.apply')}</button>
            <button className="reset" onClick={resetFilters}>{t('action.reset')}</button>
            {hiddenCaseCount > 0 && (
              <label className="hidden-toggle" title={t('operator.runs.showHiddenTitle')}>
                <input
                  type="checkbox"
                  checked={showHiddenArtifacts}
                  onChange={e => setShowHiddenArtifacts(e.target.checked)}
                />
                {t('operator.runs.showHidden').replace('{count}', String(hiddenCaseCount))}
              </label>
            )}
            <div className="view-toggle">
              <button className={viewMode === 'grouped' ? 'active' : ''} onClick={() => setViewMode('grouped')}>{t('operator.runs.grouped')}</button>
              <button className={viewMode === 'flat' ? 'active' : ''} onClick={() => setViewMode('flat')}>{t('operator.runs.list')}</button>
            </div>
          </div>

          {loading && <div className="empty">{t('operator.runs.loading')}</div>}
          {!loading && visibleCases.length === 0 && <div className="empty">{t('operator.runs.empty')}</div>}

          {visibleCases.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('operator.runs.subject')}</th>
                  <th>{t('operator.runs.process')}</th>
                  <th>{t('operator.runs.status')}</th>
                  <th>{t('operator.runs.position')}</th>
                  <th>{t('operator.runs.created')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {viewMode === 'grouped'
                  ? buildGroups(visibleCases).map(group => (
                    <>
                      <tr key={group.process_id} className="group-row" onClick={() => toggleGroup(group.process_id)}>
                        <td colSpan={6}>
                          <span className={`group-arrow${expandedGroups.has(group.process_id) ? ' open' : ''}`}>▶</span>
                          <strong>{group.process_name}</strong>
                          <span className="group-count">
                            <span>{t('operator.runs.total').replace('{count}', String(group.counts.total))}</span>
                            {group.counts.running > 0 && <span className="gc-running">{t('operator.runs.active').replace('{count}', String(group.counts.running))}</span>}
                            {group.counts.done > 0 && <span className="gc-done">{t('operator.runs.completed').replace('{count}', String(group.counts.done))}</span>}
                            {group.counts.error > 0 && <span className="gc-error">{t('operator.runs.errors').replace('{count}', String(group.counts.error))}</span>}
                          </span>
                        </td>
                      </tr>
                      {expandedGroups.has(group.process_id) && group.cases.map(c => (
                        <tr key={c.case_id} className="child-row" onClick={() => openDetail(c)}>
                          <td><span className="link">{c.subject || t('operator.runs.noSubject')}</span></td>
                          <td>{wfNameMap[c.process_id] || c.process_id}</td>
                          <td><StatusBadge status={c.status} /></td>
                          <td className="mono">{positionLabel(c)}</td>
                          <td>{new Date(c.created_at).toLocaleString()}</td>
                          <td onClick={e => { e.stopPropagation(); setRunCaseId(c.case_id); }}>
                            <button className="btn-open-schema">{t('operator.runs.schema')}</button>
                          </td>
                        </tr>
                      ))}
                    </>
                  ))
                  : visibleCases.map(c => (
                    <tr key={c.case_id} onClick={() => openDetail(c)}>
                      <td><span className="link">{c.subject || t('operator.runs.noSubject')}</span></td>
                      <td>{wfNameMap[c.process_id] || c.process_id}</td>
                      <td><StatusBadge status={c.status} /></td>
                      <td className="mono">{positionLabel(c)}</td>
                      <td>{new Date(c.created_at).toLocaleString()}</td>
                      <td onClick={e => { e.stopPropagation(); setRunCaseId(c.case_id); }}>
                        <button className="btn-open-schema">{t('operator.runs.schema')}</button>
                      </td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          )}

          {viewMode === 'flat' && total > PAGE_SIZE && (
            <div className="pagination">
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>{t('operator.runs.back')}</button>
              <span>{t('operator.runs.pageSummary').replace('{page}', String(currentPage)).replace('{pages}', String(totalPages)).replace('{total}', String(total))}</span>
              <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>{t('operator.runs.next')}</button>
            </div>
          )}

          <div className="refresh-info">{t('operator.runs.refresh').replace('{time}', lastUpdate)}</div>
        </div>
      </div>

      {runCaseId && (
        <RunOverlay caseId={runCaseId} onClose={() => setRunCaseId(null)} />
      )}

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

            <button className="btn-schema" onClick={() => { setRunCaseId(selectedCase.case_id); setSelectedCase(null); }}>
              🗺 {t('operator.runs.openDiagram')}
            </button>

            <div className="section-title">{t('operator.runs.data')}</div>
            <pre className="payload-code">{JSON.stringify(selectedCase.payload, null, 2)}</pre>

            <div className="section-title">{t('operator.runs.history').replace('{count}', String(selectedCase.history?.length || 0))}</div>
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
              <div style={{ color: '#999', fontSize: 13 }}>{t('operator.runs.emptyHistory')}</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
