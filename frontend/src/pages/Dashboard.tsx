import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useToken } from '../context/TokenContext';
import { useSetSubtitle } from '../context/SubtitleContext';
import { useI18n } from '../context/I18nContext';
import { api } from '../api/client';
import type { Run, Agent } from '../api/types';

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
  const { lang } = useI18n();
  const [wfCount, setWfCount] = useState<number | null>(null);
  const [wiCount, setWiCount] = useState<number | null>(null);
  const [recentRuns, setRecentRuns] = useState<Run[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runCount, setRunCount] = useState<number | null>(null);
  useSetSubtitle('AI Factory — coMind');

  useEffect(() => {
    if (!token) return;
    Promise.all([
      api.workflows.list().catch(() => []),
      api.workitems.list().catch(() => []),
      api.runs.list({ limit: 5 }).catch(() => ({ cases: [], total: 0 })),
      api.agents.list().catch(() => []),
    ]).then(([wfs, all, runsRes, agentsList]) => {
      setWfCount(Array.isArray(wfs) ? wfs.length : 0);
      setWiCount(Array.isArray(all) ? all.filter((i: any) => i.status === 'pending' || i.status === 'assigned').length : 0);
      setRecentRuns(runsRes.cases || []);
      setRunCount(runsRes.total ?? null);
      setAgents(Array.isArray(agentsList) ? agentsList : []);
    });
  }, [token]);

  const onlineAgents = agents.filter(a => a.status === 'online');

  return (
    <>
      <style>{styles}</style>
      <div className="container">
        <div className="grid" id="stats">
          <div className="card">
            <h3>{lang === 'ru' ? 'Процессы' : 'Processes'}</h3>
            <div className="value" id="wf-count">{wfCount ?? '—'}</div>
            <div className="sub">{lang === 'ru' ? 'зарегистрировано' : 'registered'}</div>
          </div>
          <div className="card">
            <h3>{lang === 'ru' ? 'Кейсы' : 'Cases'}</h3>
            <div className="value">{runCount ?? '—'}</div>
            <div className="sub">{lang === 'ru' ? 'всего запущено' : 'total runs'}</div>
          </div>
          <div className="card">
            <h3>{lang === 'ru' ? 'Задачи' : 'Tasks'}</h3>
            <div className="value" id="wi-count">{wiCount ?? '—'}</div>
            <div className="sub">{lang === 'ru' ? 'ожидание + назначены' : 'pending + assigned'}</div>
          </div>
        </div>

        <div className="dash-panels">
          {/* Recent runs */}
          <div className="panel">
            <h2>{lang === 'ru' ? 'Последние прогоны' : 'Recent Runs'}</h2>
            <div className="run-list">
              {recentRuns.length === 0 && (
                <div style={{ color: '#94a3b8', fontSize: 13 }}>{lang === 'ru' ? 'Нет прогонов' : 'No runs'}</div>
              )}
              {recentRuns.map(r => (
                <div key={r.case_id} className="run-row">
                  <div className={`run-dot ${r.status}`} />
                  <div className="run-name" title={r.subject}>{r.subject}</div>
                  <div className="run-time">{fmtDate(r.created_at)}</div>
                </div>
              ))}
            </div>
            <Link to="/monitor" className="panel-footer">{lang === 'ru' ? 'Все прогоны →' : 'All runs →'}</Link>
          </div>

          {/* Online agents */}
          <div className="panel">
            <h2>{lang === 'ru' ? `Агенты онлайн (${onlineAgents.length})` : `Agents online (${onlineAgents.length})`}</h2>
            <div className="agent-list">
              {onlineAgents.length === 0 && (
                <div style={{ color: '#94a3b8', fontSize: 13 }}>{lang === 'ru' ? 'Нет активных агентов' : 'No agents online'}</div>
              )}
              {onlineAgents.slice(0, 8).map(a => (
                <div key={a.id} className="agent-row">
                  <div className="agent-dot online" />
                  <div className="agent-name">{a.name || a.id}</div>
                  <div className="agent-status">{a.id}</div>
                </div>
              ))}
            </div>
            <Link to="/agents" className="panel-footer">{lang === 'ru' ? 'Все агенты →' : 'All agents →'}</Link>
          </div>
        </div>

        <div className="panel">
          <h2>{lang === 'ru' ? 'Навигация' : 'Navigation'}</h2>
          <div className="links">
            <a href="/ui/processes"><span className="icon">🗂</span> {lang === 'ru' ? 'Реестр процессов — eEPC-процессы и активные кейсы' : 'Process Registry — eEPC processes and cases'}</a>
            <a href="/ui/workitems"><span className="icon">✅</span> {lang === 'ru' ? 'Задачи — очередь задач с фильтрами и действиями' : 'Tasks — task queue with filters and actions'}</a>
          </div>
        </div>
      </div>
    </>
  );
}
