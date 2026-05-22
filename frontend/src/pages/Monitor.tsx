/**
 * Monitor — unified process execution screen.
 * Replaces Cases + old Monitor + partly WorkItems.
 * Left panel: runs grouped by process with status/SLA.
 * Right panel: EPC diagram with highlighted current step + history timeline.
 */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { EpcRenderer } from '../components/EpcRenderer';
import { useToken } from '../context/TokenContext';
import { useI18n } from '../context/I18nContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { EventWait, Run, RuntimeEffectRecord, RuntimeEffectsSummary, Workflow } from '../api/types';
import { buildRoleLabelMap } from '../utils/agentDisplay';
import { filterOperatorRuns, isWorkflowHiddenFromOperator, useOperatorViewMode } from '../utils/operatorView';
import { MonitorOpsPanel, type MonitorRecoveryAction } from './MonitorOpsPanel';
import './Monitor.css';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

function fmtElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
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

function statusLabel(s: string, t: (key: string) => string): string {
  if (s === 'running') return t('operator.runs.statusRunning');
  if (s === 'done') return t('run.status.done');
  if (s === 'error') return t('run.status.error');
  return s;
}

// ── Styles ────────────────────────────────────────────────────────────────────


// ── Component ─────────────────────────────────────────────────────────────────

export function Monitor() {
  const token = useToken();
  const { lang, t } = useI18n();
  const location = useLocation();
  const { showHiddenArtifacts, setShowHiddenArtifacts } = useOperatorViewMode();

  const [runs, setRuns] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [selectedWf, setSelectedWf] = useState<Workflow | null>(null);
  const [wfNameMap, setWfNameMap] = useState<Record<string, string>>({});
  const [hiddenProcessIds, setHiddenProcessIds] = useState<Set<string>>(new Set());
  const [roleLabels, setRoleLabels] = useState<Record<string, string>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [wfLoadState, setWfLoadState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [runtimeEffects, setRuntimeEffects] = useState<RuntimeEffectRecord[]>([]);
  const [runtimeEffectSummary, setRuntimeEffectSummary] = useState<RuntimeEffectsSummary | null>(null);
  const [waits, setWaits] = useState<EventWait[]>([]);
  const [opsLoading, setOpsLoading] = useState(false);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [effectActionId, setEffectActionId] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState('');
  const [processFilter, setProcessFilter] = useState('');
  const [search, setSearch] = useState('');
  const [expandedPayload, setExpandedPayload] = useState<string | null>(null); // tl-row key
  const [closingRun, setClosingRun] = useState(false);
  const targetCaseId = new URLSearchParams(location.search).get('case_id');

  // Load workflow names for group headings
  useEffect(() => {
    if (!token) return;
    api.workflows.list().then(wfs => {
      const m: Record<string, string> = {};
      wfs.forEach(wf => { m[wf.id] = wf.name || wf.id; });
      setWfNameMap(m);
      setHiddenProcessIds(new Set(wfs.filter(isWorkflowHiddenFromOperator).map(wf => wf.id)));
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

  const loadOps = useCallback(() => {
    if (!token) return;
    setOpsLoading(true);
    Promise.all([
      api.runtimeEffects.list({ status: ['retry', 'failed', 'dead_letter'], limit: 50 }),
      api.waits.list(),
    ])
      .then(([effectsResult, waitsResult]) => {
        setRuntimeEffects(effectsResult.effects);
        setRuntimeEffectSummary(effectsResult.summary);
        setWaits(waitsResult.waits);
        setOpsError(null);
      })
      .catch(e => setOpsError(e.message))
      .finally(() => setOpsLoading(false));
  }, [token]);

  useEffect(() => { loadOps(); }, [loadOps]);
  useInterval(loadOps, 10000);

  useEffect(() => {
    if (!targetCaseId || selectedRun?.case_id === targetCaseId) return;
    const target = runs.find(run => run.case_id === targetCaseId);
    if (!target) return;
    setSelectedRun(target);
    setProcessFilter(target.process_id);
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      next.delete(target.process_id);
      return next;
    });
  }, [runs, selectedRun?.case_id, targetCaseId]);

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
  const operatorRuns = filterOperatorRuns(runs, hiddenProcessIds, { showHiddenArtifacts });
  const hiddenRunCount = runs.length - filterOperatorRuns(runs, hiddenProcessIds).length;
  const runsById = useMemo(() => new Map(runs.map(run => [run.case_id, run])), [runs]);
  const filtered = operatorRuns.filter(r => {
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

  const selectCase = useCallback((caseId: string) => {
    const existing = runsById.get(caseId);
    if (existing) {
      setSelectedRun(existing);
      setProcessFilter(existing.process_id);
      setCollapsedGroups(prev => {
        const next = new Set(prev);
        next.delete(existing.process_id);
        return next;
      });
      return;
    }
    api.runs.get(caseId)
      .then(run => {
        setSelectedRun(run);
        setProcessFilter(run.process_id);
        setRuns(prev => prev.some(item => item.case_id === run.case_id) ? prev : [run, ...prev]);
        setCollapsedGroups(prev => {
          const next = new Set(prev);
          next.delete(run.process_id);
          return next;
        });
      })
      .catch(e => setOpsError(e.message));
  }, [runsById]);

  const recoverEffect = useCallback(async (effect: RuntimeEffectRecord, action: MonitorRecoveryAction) => {
    setEffectActionId(effect.effect_id);
    try {
      const reason = action === 'retry'
        ? 'operator retry from monitor failed-effect view'
        : 'operator dead-letter from monitor failed-effect view';
      if (action === 'retry') {
        await api.runtimeEffects.retry(effect.effect_id, { actor: 'operator:monitor', reason });
      } else {
        await api.runtimeEffects.deadLetter(effect.effect_id, { actor: 'operator:monitor', reason });
      }
      await loadOps();
    } catch (e: any) {
      setOpsError(e.message);
    } finally {
      setEffectActionId(null);
    }
  }, [loadOps]);

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
              {t('operator.runs.title')}
              {operatorRuns.length > 0 && <span style={{ fontWeight: 400, color: '#94a3b8', fontSize: 13, marginLeft: 8 }}>({operatorRuns.length})</span>}
            </h2>
            <div className="mon-filters">
              <div className="mon-filter-row">
                <input
                  placeholder={t('operator.monitor.search')}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <div className="mon-filter-row">
                <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                  <option value="">{t('operator.runs.allStatuses')}</option>
                  <option value="running">{t('operator.runs.statusRunning')}</option>
                  <option value="done">{t('run.status.done')}</option>
                  <option value="error">{t('run.status.error')}</option>
                </select>
              </div>
              {hiddenRunCount > 0 && (
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#64748b' }}
                  title={t('operator.monitor.hiddenTitle')}
                >
                  <input
                    type="checkbox"
                    checked={showHiddenArtifacts}
                    onChange={e => setShowHiddenArtifacts(e.target.checked)}
                  />
                  {t('operator.monitor.hidden').replace('{count}', String(hiddenRunCount))}
                </label>
              )}
            </div>
          </div>

          <div style={{ padding: '4px 16px 6px', display: 'flex', gap: 12, fontSize: 11, color: '#64748b', borderBottom: '1px solid #f1f5f9', flexWrap: 'wrap' }}>
            <span title={t('operator.monitor.runStatus')}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#3b82f6', marginRight: 3 }} />
              {t('operator.monitor.runningLegend')}
            </span>
            <span>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#ef4444', marginRight: 3 }} />
              {t('operator.monitor.errorLegend')}
            </span>
            <span style={{ marginLeft: 8, color: '#94a3b8' }}>SLA:</span>
            <span title={t('operator.monitor.running4h')}>
              <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#f59e0b', marginRight: 3 }} />
              &gt;4h
            </span>
            <span title={t('operator.monitor.running24h')}>
              <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#ef4444', marginRight: 3 }} />
              &gt;24h ({t('operator.monitor.stuck')})
            </span>
          </div>

          <MonitorOpsPanel
            effects={runtimeEffects}
            effectSummary={runtimeEffectSummary}
            waits={waits}
            runsById={runsById}
            processNames={wfNameMap}
            loading={opsLoading}
            error={opsError}
            actionBusyId={effectActionId}
            onRecoverEffect={recoverEffect}
            onSelectCase={selectCase}
            t={t}
          />

          <div className="mon-runs-list">
            {loading && <div className="mon-loading">{t('operator.runs.loading')}</div>}
            {error && <div className="mon-error">{error}</div>}
            {!loading && filtered.length === 0 && (
              <div className="mon-loading" style={{ color: '#94a3b8' }}>
                {t('operator.runs.empty')}
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
                          ? t('operator.monitor.executionError')
                          : r.status === 'running'
                          ? t('operator.runs.statusRunning')
                          : t('operator.monitor.done')}
                      />
                      <div className="run-info">
                        <div className="run-subject">{r.subject}</div>
                        <div className="run-step">{currentStep(r)}</div>
                        <div className="run-meta">
                          <span>{statusLabel(r.status, t)}</span>
                          <span>{fmtTime(r.created_at)}</span>
                          {r.status === 'running' && <span>{fmtElapsed(elapsedMs(r.created_at))}</span>}
                          {r.status === 'running' && elapsedMs(r.created_at) > 24 * 3_600_000 && (
                            <span style={{ color: '#ef4444', fontWeight: 600 }}>
                              ⚠ {t('operator.monitor.stuck')}
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
                                ? t('operator.monitor.running24h')
                                : slaClass(r) === 'sla-warn'
                                ? t('operator.monitor.delayed')
                                : t('operator.monitor.onSchedule')
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
              {t('placeholder.selectRun')}
            </div>
          ) : (
            <div className="run-detail">
              <div className="run-detail-head">
                <h2>{selectedRun.subject}</h2>
                <div className="run-detail-meta">
                  <div className="chip">
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(selectedRun.status), display: 'inline-block' }} />
                    <b>{statusLabel(selectedRun.status, t)}</b>
                  </div>
                  <div className="chip">
                    {t('operator.monitor.processLabel')}
                    <b>{wfNameMap[selectedRun.process_id] || selectedRun.process_id}</b>
                  </div>
                  <div className="chip">
                    {t('operator.monitor.startedLabel')}
                    <b>{fmtTime(selectedRun.created_at)}</b>
                  </div>
                  {selectedRun.status === 'running' && (
                    <div className="chip">
                      {t('operator.monitor.durationLabel')}
                      <b>{fmtElapsed(elapsedMs(selectedRun.created_at))}</b>
                    </div>
                  )}
                </div>
              </div>

              {/* Payload (trigger data) */}
              {selectedRun.payload && Object.keys(selectedRun.payload).length > 0 && (
                <details style={{ padding: '4px 20px', borderBottom: '1px solid #e2e8f0', background: '#fff', flexShrink: 0 }}>
                  <summary style={{ fontSize: 12, color: '#64748b', cursor: 'pointer', userSelect: 'none', fontWeight: 600 }}>
                    {t('operator.monitor.runPayload')}
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
                    {t('operator.monitor.loadingDiagram')}
                  </div>
                ) : wfLoadState === 'error' ? (
                  <div style={{ padding: 40, color: '#ef4444', textAlign: 'center', fontSize: 14 }}>
                    {t('operator.monitor.diagramUnavailable')}
                  </div>
                ) : null}
              </div>

              {/* Timeline */}
              <div className="run-timeline">
                <div className="timeline-head">
                  <span style={{ flex: 1 }}>{t('operator.monitor.history')}</span>
                  {selectedRun.status === 'running' && (
                    <button
                      className="btn-close-run"
                      disabled={closingRun}
                      onClick={async () => {
                        if (!confirm(t('operator.monitor.confirmForceClose'))) return;
                        setClosingRun(true);
                        try {
                          await api.cases.close(selectedRun.case_id);
                          load();
                          setSelectedRun(r => r ? { ...r, status: 'done' } : r);
                        } finally { setClosingRun(false); }
                      }}
                    >{t('operator.monitor.forceClose')}</button>
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
                      {t('operator.monitor.noHistory')}
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
