import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useToken } from '../context/TokenContext';
import { useSetSubtitle } from '../context/SubtitleContext';
import { useI18n } from '../context/I18nContext';
import { api } from '../api/client';
import type { Run, Agent, EventWait } from '../api/types';

const styles = `
  .container { max-width: 1200px; margin: 0 auto; padding: 28px 24px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 28px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; }
  .card h3 { font-size: 13px; color: #64748b; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 8px; }
  .card .value { font-size: 32px; font-weight: 700; color: #0f172a; }
  .card .sub { font-size: 12px; color: #94a3b8; margin-top: 4px; }
  .dash-panels { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
  .panel { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; }
  .panel h2 { font-size: 15px; font-weight: 600; margin-bottom: 14px; color: #0f172a; }
  .runtime-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .runtime-metric { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; }
  .runtime-metric .label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #64748b; margin-bottom: 4px; }
  .runtime-metric .value { font-size: 22px; font-weight: 700; color: #0f172a; }
  .runtime-metric.warn .value { color: #d97706; }
  .runtime-metric.err .value { color: #dc2626; }
  .runtime-metric.info .value { color: #2563eb; }
  .panel-footer { font-size: 12px; color: #6366f1; text-decoration: none; margin-top: 12px; display: inline-block; }
  .panel-footer:hover { text-decoration: underline; }
  .links { display: flex; flex-direction: column; gap: 8px; }
  .links a { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 8px; text-decoration: none; color: #334155; background: #f8fafc; border: 1px solid #e2e8f0; font-size: 14px; }
  .links a:hover { background: #f1f5f9; border-color: #cbd5e1; }
  .links a .icon { font-size: 18px; }
  /* Recent runs list */
  .run-list { display: flex; flex-direction: column; gap: 6px; }
  .run-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; background: #f8fafc; border: 1px solid #e2e8f0; font-size: 13px; }
  .run-row:hover { background: #f1f5f9; }
  .run-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .run-dot.running { background: #3b82f6; }
  .run-dot.done { background: #22c55e; }
  .run-dot.error { background: #ef4444; }
  .run-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #334155; font-weight: 500; }
  .run-time { font-size: 11px; color: #94a3b8; flex-shrink: 0; }
  /* Agent list */
  .agent-list { display: flex; flex-direction: column; gap: 4px; }
  .agent-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; font-size: 13px; }
  .agent-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .agent-dot.online { background: #10b981; }
  .agent-dot.offline { background: #9ca3af; }
  .agent-name { flex: 1; color: #334155; }
  .agent-status { font-size: 11px; color: #94a3b8; }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } .dash-panels { grid-template-columns: 1fr; } }
`;

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

export function Dashboard() {
  const token = useToken();
  const { t } = useI18n();
  const [wfCount, setWfCount] = useState<number | null>(null);
  const [wiCount, setWiCount] = useState<number | null>(null);
  const [recentRuns, setRecentRuns] = useState<Run[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runCount, setRunCount] = useState<number | null>(null);
  const [runtimeHealth, setRuntimeHealth] = useState({
    runningCases: 0,
    errorCases: 0,
    attentionCases: 0,
    activeWaits: 0,
    overdueWaits: 0,
    escalatedWaits: 0,
    pendingTasks: 0,
    eventErrors: 0,
    manualFallback: 0,
  });
  useSetSubtitle('AI Factory — coMind');

  useEffect(() => {
    if (!token) return;
    Promise.all([
      api.workflows.list().catch(() => []),
      api.workitems.list().catch(() => []),
      api.runs.list({ limit: 1000 }).catch(() => ({ cases: [], total: 0 })),
      api.agents.list().catch(() => []),
      api.waits.list().catch(() => ({ waits: [], summary: { total: 0, active: 0, overdue: 0, escalated: 0, manual: 0 } })),
      api.eventMonitor.subscriptions().catch(() => ({ subscriptions: [], summary: { total: 0, waiting: 0, fired_today: 0, errors: 0, manual_fallback: 0 } })),
    ]).then(([wfs, all, runsRes, agentsList, waitsRes, eventRes]) => {
      setWfCount(Array.isArray(wfs) ? wfs.length : 0);
      setWiCount(Array.isArray(all) ? all.filter((i: any) => i.status === 'pending' || i.status === 'assigned').length : 0);
      setRecentRuns((runsRes.cases || []).slice(0, 5));
      setRunCount(runsRes.total ?? null);
      setAgents(Array.isArray(agentsList) ? agentsList : []);
      const runCases = Array.isArray(runsRes.cases) ? runsRes.cases : [];
      const waits = waitsRes.waits || [];
      setRuntimeHealth({
        runningCases: runCases.filter((run: any) => run.status === 'running').length,
        errorCases: runCases.filter((run: any) => run.status === 'error').length,
        attentionCases: runCases.filter((run: any) => run.needs_attention === true).length,
        activeWaits: waits.length,
        overdueWaits: waits.filter((wait: EventWait) => wait.status === 'overdue').length,
        escalatedWaits: waits.filter((wait: EventWait) => wait.status === 'escalated').length,
        pendingTasks: Array.isArray(all) ? all.filter((item: any) => item.status === 'pending' || item.status === 'running').length : 0,
        eventErrors: eventRes.summary.errors ?? 0,
        manualFallback: eventRes.summary.manual_fallback ?? 0,
      });
    });
  }, [token]);

  const onlineAgents = agents.filter(a => a.status === 'online');

  return (
    <>
      <style>{styles}</style>
      <div className="container">
        <div className="grid" id="stats">
          <div className="card">
            <h3>{t('operator.dashboard.processes')}</h3>
            <div className="value" id="wf-count">{wfCount ?? '—'}</div>
            <div className="sub">{t('operator.dashboard.processesSub')}</div>
          </div>
          <div className="card">
            <h3>{t('operator.dashboard.runs')}</h3>
            <div className="value">{runCount ?? '—'}</div>
            <div className="sub">{t('operator.dashboard.runsSub')}</div>
          </div>
          <div className="card">
            <h3>{t('operator.dashboard.workItems')}</h3>
            <div className="value" id="wi-count">{wiCount ?? '—'}</div>
            <div className="sub">{t('operator.dashboard.workItemsSub')}</div>
          </div>
        </div>

        <div className="dash-panels">
          <div className="panel">
            <h2>{t('operator.dashboard.runtimeHealth')}</h2>
            <div className="runtime-metrics">
              <div className="runtime-metric info">
                <div className="label">{t('operator.dashboard.runningRuns')}</div>
                <div className="value">{runtimeHealth.runningCases}</div>
              </div>
              <div className={`runtime-metric${runtimeHealth.errorCases > 0 ? ' err' : ''}`}>
                <div className="label">{t('operator.dashboard.runErrors')}</div>
                <div className="value">{runtimeHealth.errorCases}</div>
              </div>
              <div className="runtime-metric info">
                <div className="label">{t('operator.dashboard.activeWaits')}</div>
                <div className="value">{runtimeHealth.activeWaits}</div>
              </div>
              <div className={`runtime-metric${runtimeHealth.overdueWaits + runtimeHealth.escalatedWaits > 0 ? ' warn' : ''}`}>
                <div className="label">{t('operator.dashboard.attentionWaits')}</div>
                <div className="value">{runtimeHealth.overdueWaits + runtimeHealth.escalatedWaits}</div>
              </div>
              <div className="runtime-metric info">
                <div className="label">{t('operator.dashboard.activeWorkItems')}</div>
                <div className="value">{runtimeHealth.pendingTasks}</div>
              </div>
              <div className={`runtime-metric${runtimeHealth.eventErrors + runtimeHealth.manualFallback > 0 ? ' err' : ''}`}>
                <div className="label">{t('operator.dashboard.eventPipeline')}</div>
                <div className="value">{runtimeHealth.eventErrors + runtimeHealth.manualFallback}</div>
              </div>
            </div>
            <Link to="/event-monitor" className="panel-footer">{t('operator.dashboard.eventHealthLink')}</Link>
          </div>

          {/* Recent runs */}
          <div className="panel">
            <h2>{t('operator.dashboard.recentRuns')}</h2>
            <div className="run-list">
              {recentRuns.length === 0 && (
                <div style={{ color: '#94a3b8', fontSize: 13 }}>{t('operator.dashboard.noRuns')}</div>
              )}
              {recentRuns.map(r => (
                <div key={r.case_id} className="run-row">
                  <div className={`run-dot ${r.status}`} />
                  <div className="run-name" title={r.subject}>{r.subject}</div>
                  <div className="run-time">{fmtDate(r.created_at)}</div>
                </div>
              ))}
            </div>
            <Link to="/monitor" className="panel-footer">{t('operator.dashboard.allRuns')}</Link>
          </div>

          {/* Online agents */}
          <div className="panel">
            <h2>{t('operator.dashboard.agentsOnline').replace('{count}', String(onlineAgents.length))}</h2>
            <div className="agent-list">
              {onlineAgents.length === 0 && (
                <div style={{ color: '#94a3b8', fontSize: 13 }}>{t('operator.dashboard.noAgentsOnline')}</div>
              )}
              {onlineAgents.slice(0, 8).map(a => (
                <div key={a.id} className="agent-row">
                  <div className="agent-dot online" />
                  <div className="agent-name">{a.name || a.id}</div>
                  <div className="agent-status">{a.id}</div>
                </div>
              ))}
            </div>
            <Link to="/agents" className="panel-footer">{t('operator.dashboard.allAgents')}</Link>
          </div>
        </div>

        <div className="panel">
          <h2>{t('operator.dashboard.navigation')}</h2>
          <div className="links">
            <a href="/ui/editor"><span className="icon">🗂</span> {t('operator.dashboard.processEditorLink')}</a>
            <a href="/ui/workitems"><span className="icon">✅</span> {t('operator.dashboard.workbenchLink')}</a>
            <a href="/ui/event-monitor"><span className="icon">📡</span> {t('operator.dashboard.opsLink')}</a>
          </div>
        </div>
      </div>
    </>
  );
}
