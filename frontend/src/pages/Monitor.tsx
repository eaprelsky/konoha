/**
 * Monitor — unified process execution screen.
 * Replaces Cases + old Monitor + partly WorkItems.
 * Left panel: runs grouped by process with status/SLA.
 * Right panel: EPC diagram with highlighted current step + history timeline.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { EpcRenderer } from '../components/EpcRenderer';
import { useToken } from '../context/TokenContext';
import { useI18n } from '../context/I18nContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { Run, Workflow } from '../api/types';
import { buildRoleLabelMap } from '../utils/agentDisplay';
import './Monitor.css';

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


// ── Component ─────────────────────────────────────────────────────────────────

export function Monitor() {
  const token = useToken();
  const { lang } = useI18n();

  const [runs, setRuns] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [selectedWf, setSelectedWf] = useState<Workflow | null>(null);
  const [wfNameMap, setWfNameMap] = useState<Record<string, string>>({});
  const [roleLabels, setRoleLabels] = useState<Record<string, string>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [wfLoadState, setWfLoadState] = useState<'idle' | 'loading' | 'error'>('idle');

  const [statusFilter, setStatusFilter] = useState('');
  const [processFilter, setProcessFilter] = useState('');
  const [search, setSearch] = useState('');
  const [expandedPayload, setExpandedPayload] = useState<string | null>(null); // tl-row key
  const [closingRun, setClosingRun] = useState(false);

  // Load workflow names for group headings
  useEffect(() => {
    if (!token) return;
    api.workflows.list().then(wfs => {
      const m: Record<string, string> = {};
      wfs.forEach(wf => { m[wf.id] = wf.name || wf.id; });
      setWfNameMap(m);
    }).catch(() => {});
    api.roles.list()
      .then(roles => setRoleLabels(buildRoleLabelMap(roles)))
      .catch(() => {});
  }, [token]);

  const load = useCallback(() => {
    if (!token) return;
    const filters: Record<string, unknown> = { limit: 1000 };
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
    if (!selectedRun || !token) { setWfLoadState('idle'); return; }
    setSelectedWf(null);
    setWfLoadState('loading');
    api.workflows.get(selectedRun.process_id)
      .then(wf => { setSelectedWf(wf); setWfLoadState('idle'); })
      .catch(() => { setSelectedWf(null); setWfLoadState('error'); });
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

          <div style={{ padding: '4px 16px 6px', display: 'flex', gap: 12, fontSize: 11, color: '#64748b', borderBottom: '1px solid #f1f5f9', flexWrap: 'wrap' }}>
            <span title={lang === 'ru' ? 'Статус прогона' : 'Run status'}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#3b82f6', marginRight: 3 }} />
              {lang === 'ru' ? 'активен' : 'running'}
            </span>
            <span>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#ef4444', marginRight: 3 }} />
              {lang === 'ru' ? 'ошибка' : 'error'}
            </span>
            <span style={{ marginLeft: 8, color: '#94a3b8' }}>SLA:</span>
            <span title={lang === 'ru' ? 'Выполняется > 4 часов' : 'Running > 4 hours'}>
              <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#f59e0b', marginRight: 3 }} />
              {lang === 'ru' ? '>4ч' : '>4h'}
            </span>
            <span title={lang === 'ru' ? 'Застрял: выполняется > 24 часов' : 'Stuck: running > 24 hours'}>
              <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#ef4444', marginRight: 3 }} />
              {lang === 'ru' ? '>24ч (застрял)' : '>24h (stuck)'}
            </span>
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
                      <div
                        className={`run-dot ${r.status}`}
                        title={r.status === 'error'
                          ? (lang === 'ru' ? 'Ошибка выполнения' : 'Execution error')
                          : r.status === 'running'
                          ? (lang === 'ru' ? 'Выполняется' : 'Running')
                          : (lang === 'ru' ? 'Завершено' : 'Done')}
                      />
                      <div className="run-info">
                        <div className="run-subject">{r.subject}</div>
                        <div className="run-step">{currentStep(r)}</div>
                        <div className="run-meta">
                          <span>{statusLabel(r.status, lang)}</span>
                          <span>{fmtTime(r.created_at)}</span>
                          {r.status === 'running' && <span>{fmtElapsed(elapsedMs(r.created_at))}</span>}
                          {r.status === 'running' && elapsedMs(r.created_at) > 24 * 3_600_000 && (
                            <span style={{ color: '#ef4444', fontWeight: 600 }}>
                              {lang === 'ru' ? '⚠ застрял' : '⚠ stuck'}
                            </span>
                          )}
                        </div>
                      </div>
                      {r.status === 'running' && (
                        <div className="run-sla">
                          <div
                            className={`sla-dot ${slaClass(r)}`}
                            title={
                              slaClass(r) === 'sla-bad'
                                ? (lang === 'ru' ? 'Застрял: выполняется > 24 часов' : 'Stuck: running > 24 hours')
                                : slaClass(r) === 'sla-warn'
                                ? (lang === 'ru' ? 'Задержка: выполняется > 4 часов' : 'Delayed: running > 4 hours')
                                : (lang === 'ru' ? 'В норме' : 'On schedule')
                            }
                          />
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

              {/* Payload (trigger data) */}
              {selectedRun.payload && Object.keys(selectedRun.payload).length > 0 && (
                <details style={{ padding: '4px 20px', borderBottom: '1px solid #e2e8f0', background: '#fff', flexShrink: 0 }}>
                  <summary style={{ fontSize: 12, color: '#64748b', cursor: 'pointer', userSelect: 'none', fontWeight: 600 }}>
                    {lang === 'ru' ? 'Данные запуска (payload)' : 'Run payload'}
                  </summary>
                  <pre style={{ fontSize: 11, fontFamily: 'monospace', background: '#f1f5f9', borderRadius: 4, padding: '6px 8px', margin: '4px 0 6px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#334155', maxHeight: 100, overflowY: 'auto' }}>
                    {JSON.stringify(selectedRun.payload, null, 2)}
                  </pre>
                </details>
              )}

              {/* EPC Diagram with highlighted current step */}
              <div className="run-diagram">
                {selectedWf ? (
                  <EpcRenderer workflow={selectedWf} caseData={selectedRun} roleLabels={roleLabels} />
                ) : wfLoadState === 'loading' ? (
                  <div style={{ padding: 40, color: '#94a3b8', textAlign: 'center', fontSize: 14 }}>
                    {lang === 'ru' ? 'Загрузка диаграммы…' : 'Loading diagram…'}
                  </div>
                ) : wfLoadState === 'error' ? (
                  <div style={{ padding: 40, color: '#ef4444', textAlign: 'center', fontSize: 14 }}>
                    {lang === 'ru' ? 'Диаграмма недоступна — процесс не найден или удалён' : 'Diagram unavailable — process not found or deleted'}
                  </div>
                ) : null}
              </div>

              {/* Timeline */}
              <div className="run-timeline">
                <div className="timeline-head">
                  <span style={{ flex: 1 }}>{lang === 'ru' ? 'История' : 'History'}</span>
                  {selectedRun.status === 'running' && (
                    <button
                      className="btn-close-run"
                      disabled={closingRun}
                      onClick={async () => {
                        if (!confirm(lang === 'ru' ? 'Принудительно закрыть прогон?' : 'Force-close this run?')) return;
                        setClosingRun(true);
                        try {
                          await api.cases.close(selectedRun.case_id);
                          load();
                          setSelectedRun(r => r ? { ...r, status: 'done' } : r);
                        } finally { setClosingRun(false); }
                      }}
                    >{lang === 'ru' ? 'Закрыть' : 'Force close'}</button>
                  )}
                </div>
                <div className="tl-items">
                  {[...selectedRun.history].reverse().map((h, i) => {
                    const key = `${i}`;
                    const hasPayload = h.output && Object.keys(h.output).length > 0;
                    return (
                      <div key={key} className="tl-row" onClick={() => setExpandedPayload(p => p === key ? null : key)}>
                        <div className={`tl-icon ${tlIconClass(h.element_type)}`}>
                          {h.element_type === 'function' ? '⚙' : h.element_type === 'gateway' ? '◇' : '●'}
                        </div>
                        <div className="tl-body">
                          <div className="tl-label">{h.label}{hasPayload ? ' ▸' : ''}</div>
                          <div className="tl-time">{fmtTime(h.timestamp)}</div>
                          {expandedPayload === key && hasPayload && (
                            <div className="tl-payload">{JSON.stringify(h.output, null, 2)}</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
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
