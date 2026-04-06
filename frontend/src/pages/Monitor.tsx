/**
 * Monitor — unified process execution screen.
 * Replaces Cases + old Monitor + partly WorkItems.
 * Left panel: runs grouped by process with status/SLA.
 * Right panel: EPC diagram with highlighted current step + history timeline.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { EpcRenderer } from '../components/EpcRenderer';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { Run, Workflow } from '../api/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

function fmtElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}с`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}м`;
  return `${Math.floor(ms / 3_600_000)}ч ${Math.floor((ms % 3_600_000) / 60_000)}м`;
}

function elapsedMs(iso: string): number {
  return Date.now() - new Date(iso).getTime();
}

function statusColor(s: string) {
  if (s === 'running') return '#3b82f6';
  if (s === 'done') return '#22c55e';
  if (s === 'error') return '#ef4444';
  return '#94a3b8';
}

function statusLabel(s: string, lang: string): string {
  if (s === 'running') return lang === 'ru' ? 'Выполняется' : 'Running';
  if (s === 'done') return lang === 'ru' ? 'Выполнено' : 'Done';
  if (s === 'error') return lang === 'ru' ? 'Ошибка' : 'Error';
  return s;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const CSS = `
  .mon-root { display: grid; grid-template-columns: 340px 1fr; height: calc(100vh - 96px); overflow: hidden; background: #f8fafc; }

  /* Left panel — runs list */
  .mon-left { background: #fff; border-right: 1px solid #e2e8f0; display: flex; flex-direction: column; overflow: hidden; }
  .mon-left-head { padding: 14px 16px 10px; border-bottom: 1px solid #e2e8f0; flex-shrink: 0; }
  .mon-left-head h2 { font-size: 15px; font-weight: 700; color: #0f172a; margin-bottom: 10px; }
  .mon-filters { display: flex; flex-direction: column; gap: 6px; }
  .mon-filter-row { display: flex; gap: 6px; }
  .mon-filter-row input, .mon-filter-row select {
    flex: 1; padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 6px;
    font-size: 13px; color: #334155; background: #f8fafc; min-width: 0;
  }
  .mon-filter-row input:focus, .mon-filter-row select:focus { outline: none; border-color: #6366f1; background: #fff; }
  .mon-runs-list { flex: 1; overflow-y: auto; padding: 8px 0; }

  /* Process group */
  .proc-group { margin-bottom: 2px; }
  .proc-group-header { display: flex; align-items: center; gap: 8px; padding: 8px 16px 6px; cursor: pointer; user-select: none; }
  .proc-group-header:hover { background: #f8fafc; }
  .proc-group-name { font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: .05em; flex: 1; }
  .proc-group-count { font-size: 11px; color: #94a3b8; background: #f1f5f9; border-radius: 10px; padding: 1px 7px; }
  .proc-group-arrow { font-size: 10px; color: #94a3b8; transition: transform .15s; }
  .proc-group-arrow.open { transform: rotate(90deg); }

  /* Run item */
  .run-item { display: flex; align-items: center; gap: 10px; padding: 9px 16px 9px 24px; cursor: pointer; border-left: 3px solid transparent; }
  .run-item:hover { background: #f8fafc; }
  .run-item.active { background: #eff6ff; border-left-color: #6366f1; }
  .run-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .run-dot.running { background: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.2); animation: pulse 2s infinite; }
  .run-dot.done { background: #22c55e; }
  .run-dot.error { background: #ef4444; }
  @keyframes pulse { 0%,100% { box-shadow: 0 0 0 3px rgba(59,130,246,.2); } 50% { box-shadow: 0 0 0 5px rgba(59,130,246,.1); } }

  .run-info { flex: 1; min-width: 0; }
  .run-subject { font-size: 13px; font-weight: 600; color: #1e293b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .run-meta { font-size: 11px; color: #94a3b8; margin-top: 2px; display: flex; gap: 8px; }
  .run-step { font-size: 11px; color: #64748b; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .run-sla { flex-shrink: 0; }
  .sla-dot { width: 7px; height: 7px; border-radius: 50%; }
  .sla-ok { background: #22c55e; }
  .sla-warn { background: #f59e0b; }
  .sla-bad { background: #ef4444; }

  /* Right panel */
  .mon-right { display: flex; flex-direction: column; overflow: hidden; }
  .mon-placeholder { flex: 1; display: flex; align-items: center; justify-content: center; color: #94a3b8; font-size: 15px; }

  /* Run detail */
  .run-detail { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
  .run-detail-head { padding: 16px 20px; border-bottom: 1px solid #e2e8f0; background: #fff; flex-shrink: 0; }
  .run-detail-head h2 { font-size: 17px; font-weight: 700; color: #0f172a; }
  .run-detail-meta { display: flex; gap: 16px; margin-top: 6px; flex-wrap: wrap; }
  .run-detail-meta .chip { font-size: 12px; color: #64748b; display: flex; align-items: center; gap: 4px; }
  .run-detail-meta .chip b { color: #334155; }

  /* Diagram area */
  .run-diagram { flex: 1; overflow: auto; background: #f8fafc; min-height: 0; }

  /* Timeline */
  .run-timeline { border-top: 1px solid #e2e8f0; background: #fff; overflow-y: auto; max-height: 220px; flex-shrink: 0; }
  .timeline-head { padding: 10px 20px 6px; font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .05em; }
  .tl-items { padding: 0 20px 12px; }
  .tl-row { display: flex; gap: 12px; padding: 6px 0; }
  .tl-row:not(:last-child) { border-bottom: 1px solid #f1f5f9; }
  .tl-icon { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; }
  .tl-icon.created { background: #dbeafe; }
  .tl-icon.completed { background: #dcfce7; }
  .tl-icon.error { background: #fee2e2; }
  .tl-icon.default { background: #f1f5f9; }
  .tl-body { flex: 1; }
  .tl-label { font-size: 13px; color: #1e293b; }
  .tl-time { font-size: 11px; color: #94a3b8; margin-top: 1px; }

  /* Loading / error */
  .mon-loading { flex: 1; display: flex; align-items: center; justify-content: center; color: #94a3b8; font-size: 14px; }
  .mon-error { background: #fee2e2; color: #c33; padding: 10px 16px; margin: 8px; border-radius: 6px; font-size: 13px; border-left: 3px solid #ef4444; }
`;

// ── Component ─────────────────────────────────────────────────────────────────

export function Monitor() {
  const token = useToken();
  const lang = document.documentElement.lang || 'ru';

  const [runs, setRuns] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [selectedWf, setSelectedWf] = useState<Workflow | null>(null);
  const [wfNameMap, setWfNameMap] = useState<Record<string, string>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const [statusFilter, setStatusFilter] = useState('');
  const [processFilter, setProcessFilter] = useState('');
  const [search, setSearch] = useState('');

  // Load workflow names for group headings
  useEffect(() => {
    if (!token) return;
    api.workflows.list().then(wfs => {
      const m: Record<string, string> = {};
      wfs.forEach(wf => { m[wf.id] = wf.name || wf.id; });
      setWfNameMap(m);
    }).catch(() => {});
  }, [token]);

  const load = useCallback(() => {
    if (!token) return;
    const filters: Record<string, unknown> = { limit: 200 };
    if (statusFilter) filters.status = statusFilter;
    if (processFilter) filters.process_id = processFilter;
    api.runs.list(filters as any)
      .then(res => {
        setRuns(res.cases);
        setTotal(res.total);
        setLoading(false);
        setError(null);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token, statusFilter, processFilter]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 8000);

  // When a run is selected, load its workflow for diagram
  useEffect(() => {
    if (!selectedRun || !token) return;
    api.workflows.get(selectedRun.process_id)
      .then(setSelectedWf)
      .catch(() => setSelectedWf(null));
  }, [selectedRun, token]);

  // Group runs by process_id, filter by search
  const filtered = runs.filter(r => {
    if (!search) return true;
    return r.subject.toLowerCase().includes(search.toLowerCase())
      || r.process_id.toLowerCase().includes(search.toLowerCase());
  });

  const grouped = filtered.reduce<Record<string, Run[]>>((acc, r) => {
    const key = r.process_id;
    if (!acc[key]) acc[key] = [];
    acc[key].push(r);
    return acc;
  }, {});

  function toggleGroup(pid: string) {
    setCollapsedGroups(prev => {
      const s = new Set(prev);
      if (s.has(pid)) s.delete(pid); else s.add(pid);
      return s;
    });
  }

  function slaClass(r: Run): string {
    const ms = elapsedMs(r.created_at);
    if (r.status !== 'running') return '';
    if (ms > 24 * 3_600_000) return 'sla-bad';
    if (ms > 4 * 3_600_000) return 'sla-warn';
    return 'sla-ok';
  }

  function currentStep(r: Run): string {
    if (r.current_step_label) return r.current_step_label;
    const last = r.history?.[r.history.length - 1];
    return last?.label || '';
  }

  function tlIconClass(type: string): string {
    if (type === 'case_created' || type === 'process_started') return 'created';
    if (type === 'function_completed' || type === 'case_done') return 'completed';
    if (type === 'error' || type === 'case_error') return 'error';
    return 'default';
  }


  return (
    <>
      <style>{CSS}</style>
      <div className="mon-root">
        {/* ── Left: runs list ── */}
        <div className="mon-left">
          <div className="mon-left-head">
            <h2>
              {lang === 'ru' ? 'Прогоны' : 'Process Runs'}
              {total > 0 && <span style={{ fontWeight: 400, color: '#94a3b8', fontSize: 13, marginLeft: 8 }}>({total})</span>}
            </h2>
            <div className="mon-filters">
              <div className="mon-filter-row">
                <input
                  placeholder={lang === 'ru' ? 'Поиск…' : 'Search…'}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <div className="mon-filter-row">
                <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                  <option value="">{lang === 'ru' ? 'Все статусы' : 'All statuses'}</option>
                  <option value="running">{lang === 'ru' ? 'Выполняется' : 'Running'}</option>
                  <option value="done">{lang === 'ru' ? 'Выполнено' : 'Done'}</option>
                  <option value="error">{lang === 'ru' ? 'Ошибка' : 'Error'}</option>
                </select>
              </div>
            </div>
          </div>

          <div className="mon-runs-list">
            {loading && <div className="mon-loading">{lang === 'ru' ? 'Загрузка…' : 'Loading…'}</div>}
            {error && <div className="mon-error">{error}</div>}
            {!loading && filtered.length === 0 && (
              <div className="mon-loading" style={{ color: '#94a3b8' }}>
                {lang === 'ru' ? 'Прогоны не найдены' : 'No runs found'}
              </div>
            )}
            {Object.entries(grouped).map(([pid, groupRuns]) => {
              const isOpen = !collapsedGroups.has(pid);
              return (
                <div key={pid} className="proc-group">
                  <div className="proc-group-header" onClick={() => toggleGroup(pid)}>
                    <span className={`proc-group-arrow${isOpen ? ' open' : ''}`}>▶</span>
                    <span className="proc-group-name">{wfNameMap[pid] || pid}</span>
                    <span className="proc-group-count">{groupRuns.length}</span>
                  </div>
                  {isOpen && groupRuns.map(r => (
                    <div
                      key={r.case_id}
                      className={`run-item${selectedRun?.case_id === r.case_id ? ' active' : ''}`}
                      onClick={() => setSelectedRun(r)}
                    >
                      <div className={`run-dot ${r.status}`} />
                      <div className="run-info">
                        <div className="run-subject">{r.subject}</div>
                        <div className="run-step">{currentStep(r)}</div>
                        <div className="run-meta">
                          <span>{statusLabel(r.status, lang)}</span>
                          <span>{fmtTime(r.created_at)}</span>
                          {r.status === 'running' && <span>{fmtElapsed(elapsedMs(r.created_at))}</span>}
                        </div>
                      </div>
                      {r.status === 'running' && (
                        <div className="run-sla">
                          <div className={`sla-dot ${slaClass(r)}`} title="SLA" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right: detail ── */}
        <div className="mon-right">
          {!selectedRun ? (
            <div className="mon-placeholder">
              {lang === 'ru' ? '← Выберите прогон для просмотра деталей' : '← Select a run to view details'}
            </div>
          ) : (
            <div className="run-detail">
              <div className="run-detail-head">
                <h2>{selectedRun.subject}</h2>
                <div className="run-detail-meta">
                  <div className="chip">
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(selectedRun.status), display: 'inline-block' }} />
                    <b>{statusLabel(selectedRun.status, lang)}</b>
                  </div>
                  <div className="chip">
                    {lang === 'ru' ? 'Процесс: ' : 'Process: '}
                    <b>{wfNameMap[selectedRun.process_id] || selectedRun.process_id}</b>
                  </div>
                  <div className="chip">
                    {lang === 'ru' ? 'Запущен: ' : 'Started: '}
                    <b>{fmtTime(selectedRun.created_at)}</b>
                  </div>
                  {selectedRun.status === 'running' && (
                    <div className="chip">
                      {lang === 'ru' ? 'Время: ' : 'Duration: '}
                      <b>{fmtElapsed(elapsedMs(selectedRun.created_at))}</b>
                    </div>
                  )}
                </div>
              </div>

              {/* EPC Diagram with highlighted current step */}
              <div className="run-diagram">
                {selectedWf ? (
                  <EpcRenderer workflow={selectedWf} caseData={selectedRun} />
                ) : (
                  <div style={{ padding: 40, color: '#94a3b8', textAlign: 'center', fontSize: 14 }}>
                    {lang === 'ru' ? 'Загрузка диаграммы…' : 'Loading diagram…'}
                  </div>
                )}
              </div>

              {/* Timeline */}
              <div className="run-timeline">
                <div className="timeline-head">{lang === 'ru' ? 'История' : 'History'}</div>
                <div className="tl-items">
                  {[...selectedRun.history].reverse().map((h, i) => (
                    <div key={i} className="tl-row">
                      <div className={`tl-icon ${tlIconClass(h.element_type)}`}>
                        {h.element_type === 'function' ? '⚙' : h.element_type === 'gateway' ? '◇' : '●'}
                      </div>
                      <div className="tl-body">
                        <div className="tl-label">{h.label}</div>
                        <div className="tl-time">{fmtTime(h.timestamp)}</div>
                      </div>
                    </div>
                  ))}
                  {selectedRun.history.length === 0 && (
                    <div style={{ color: '#94a3b8', fontSize: 13, padding: '8px 0' }}>
                      {lang === 'ru' ? 'История пуста' : 'No history yet'}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
