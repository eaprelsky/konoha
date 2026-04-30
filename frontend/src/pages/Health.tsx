/**
 * Health — unified system health + admin page (closes #351).
 * Consolidates former /health and /admin pages.
 * Sections: Bus, Agents, System, Connectors, Quick Actions.
 */
import { useState, useCallback, useEffect } from 'react';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { useI18n } from '../context/I18nContext';
import { api } from '../api/client';
import type { Agent, TelegramStreamHealthSummary, TelegramStreamStatus } from '../api/types';

const LIFECYCLE_LABELS: Record<string, string> = {
  running: 'запущен', starting: 'запускается', stopped: 'остановлен', error: 'ошибка',
};

const styles = `
  .h-body { padding: 20px; }
  .container { max-width: 1200px; margin: 0 auto; }
  .h-section { font-size: 18px; font-weight: 700; color: #1e293b; margin: 24px 0 12px; padding-bottom: 6px; border-bottom: 2px solid #e2e8f0; }
  .h-section:first-child { margin-top: 0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 16px; }
  .panel { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .panel h2 { font-size: 15px; font-weight: 700; color: #1e293b; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; gap: 8px; }
  .kv { display: flex; justify-content: space-between; align-items: center; padding: 7px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
  .kv:last-child { border-bottom: none; }
  .kv-key { color: #64748b; }
  .kv-val { font-weight: 600; color: #1e293b; font-family: monospace; font-size: 12px; }
  .status-ok { color: #10b981; font-weight: 600; }
  .status-err { color: #ef4444; font-weight: 600; }
  .status-dot { display: inline-block; border-radius: 50%; flex-shrink: 0; }
  .dot-green { background: #10b981; }
  .dot-gray { background: #9ca3af; }
  .dot-red { background: #ef4444; }
  .dot-blue { background: #3b82f6; }
  .dot-yellow { background: #f59e0b; }
  .big-status { text-align: center; padding: 8px 0 12px; }
  .big-dot { width: 16px; height: 16px; border-radius: 50%; display: inline-block; margin-bottom: 8px; }
  .big-label { font-size: 18px; font-weight: 700; }
  .big-ts { font-size: 12px; color: #888; margin-top: 4px; }
  .agent-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
  .agent-row:last-child { border-bottom: none; }
  .agent-name-col { display: flex; align-items: center; gap: 6px; }
  .agent-name { font-weight: 600; }
  .agent-id { font-size: 11px; color: #888; font-family: monospace; }
  .agent-meta { text-align: right; font-size: 11px; color: #64748b; }
  .adapter-row { display: flex; justify-content: space-between; align-items: center; padding: 7px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
  .adapter-row:last-child { border-bottom: none; }
  .stream-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .stream-table th { color: #64748b; text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-size: 11px; text-transform: uppercase; }
  .stream-table td { padding: 7px 8px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  .stream-code { font-family: monospace; color: #334155; }
  .status-pill { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
  .pill-ok { background: #dcfce7; color: #166534; }
  .pill-warn { background: #fef3c7; color: #92400e; }
  .pill-fail { background: #fee2e2; color: #991b1b; }
  .check-btn { padding: 4px 10px; border: 1px solid #ddd; background: white; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .check-btn:hover { background: #f8fafc; }
  .action-btn { padding: 9px 14px; border: 1px solid #ddd; background: white; border-radius: 4px; cursor: pointer; font-size: 13px; text-align: left; width: 100%; margin-bottom: 8px; }
  .action-btn:hover { background: #f8fafc; }
  .action-btn.danger { color: #ef4444; border-color: #fca5a5; }
  .refresh-info { font-size: 11px; color: #999; text-align: right; margin-top: 8px; }
  .empty { color: #999; font-size: 13px; text-align: center; padding: 16px; }
  @media (max-width: 768px) { .grid2 { grid-template-columns: 1fr; } }
`;

function DotStatus({ status }: { status: string }) {
  const cls = status === 'online' ? 'dot-green' : status === 'error' ? 'dot-red' : 'dot-gray';
  return <span className={`status-dot ${cls}`} style={{ width: 8, height: 8, marginRight: 4 }} />;
}

function streamStatusClass(status: TelegramStreamStatus): string {
  if (status === 'fail') return 'pill-fail';
  if (status === 'warn') return 'pill-warn';
  return 'pill-ok';
}

export function Health() {
  const token = useToken();
  const { lang } = useI18n();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [adapters, setAdapters] = useState<string[]>([]);
  const [adapterHealth, setAdapterHealth] = useState<Record<string, boolean | null>>({});
  const [apiHealth, setApiHealth] = useState<{ status: string; ts: string } | null>(null);
  const [telegramStreams, setTelegramStreams] = useState<TelegramStreamHealthSummary | null>(null);
  const [busStatus, setBusStatus] = useState<{ status: string; ts: string } | null>(null);
  const [busError, setBusError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState('-');

  const load = useCallback(() => {
    if (!token) return;
    Promise.all([
      api.agents.list(),
      api.adapters.list().catch(() => ({ adapters: [] })),
      fetch('/api/health').then(r => r.json()).catch(() => null),
      api.health.bus().catch((e: Error) => { setBusError(e.message); return null; }),
      api.connectors.telegramStreamHealth().catch(() => null),
    ]).then(([ags, adps, hlth, bus, streams]) => {
      setAgents(ags);
      setAdapters(Array.isArray(adps) ? adps : (adps?.adapters ?? []));
      if (hlth) setApiHealth(hlth);
      if (bus) { setBusStatus(bus); setBusError(null); }
      setTelegramStreams(streams);
      setLastUpdate(new Date().toLocaleTimeString());
      setError(null);
    }).catch(e => setError(e.message));
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 15000);

  async function checkAdapter(name: string) {
    try {
      const res = await api.adapters.health(name);
      setAdapterHealth(prev => ({ ...prev, [name]: res.healthy }));
    } catch {
      setAdapterHealth(prev => ({ ...prev, [name]: false }));
    }
  }

  const online = agents.filter(a => a.status === 'online').length;
  const running = agents.filter(a => a.lifecycle?.status === 'running').length;

  const t = (ru: string, en: string) => lang === 'ru' ? ru : en;

  return (
    <>
      <style>{styles}</style>
      <div className="h-body">
        <div className="container">
          {error && <div style={{ background: '#fee', color: '#c33', padding: '10px 14px', borderRadius: 4, marginBottom: 16, borderLeft: '4px solid #c33' }}>{error}</div>}

          {/* ── Bus ── */}
          <div className="h-section">{t('Шина', 'Bus')}</div>
          <div className="grid2">
            <div className="panel">
              <h2>Konoha Bus</h2>
              {busError ? (
                <div className="big-status">
                  <div className="big-dot" style={{ background: '#ef4444' }} />
                  <div className="big-label" style={{ color: '#ef4444' }}>ERROR</div>
                  <div className="big-ts">{busError}</div>
                </div>
              ) : busStatus ? (
                <div className="big-status">
                  <div className="big-dot" style={{ background: busStatus.status === 'ok' ? '#10b981' : '#f59e0b' }} />
                  <div className="big-label" style={{ color: busStatus.status === 'ok' ? '#10b981' : '#f59e0b' }}>
                    {busStatus.status.toUpperCase()}
                  </div>
                  <div className="big-ts">{new Date(busStatus.ts).toLocaleString()}</div>
                </div>
              ) : (
                <div className="big-status"><div className="big-ts">{t('Загрузка…', 'Loading…')}</div></div>
              )}
            </div>

            <div className="panel">
              <h2>{t('Агенты', 'Agents')}</h2>
              <div className="kv">
                <span className="kv-key">{t('Зарегистрировано', 'Registered')}</span>
                <span className="kv-val">{agents.length}</span>
              </div>
              <div className="kv">
                <span className="kv-key"><span className="status-dot dot-green" style={{ width: 8, height: 8, marginRight: 5 }} />{t('Онлайн', 'Online')}</span>
                <span className="kv-val" style={{ color: '#10b981' }}>{online}</span>
              </div>
              <div className="kv">
                <span className="kv-key"><span className="status-dot dot-gray" style={{ width: 8, height: 8, marginRight: 5 }} />{t('Оффлайн', 'Offline')}</span>
                <span className="kv-val" style={{ color: '#9ca3af' }}>{agents.length - online}</span>
              </div>
              <div className="kv">
                <span className="kv-key"><span className="status-dot dot-blue" style={{ width: 8, height: 8, marginRight: 5 }} />{t('Запущено (lifecycle)', 'Running (lifecycle)')}</span>
                <span className="kv-val" style={{ color: '#3b82f6' }}>{running}</span>
              </div>
              <div className="refresh-info">{t('Последнее:', 'Last:')} {lastUpdate}</div>
            </div>
          </div>

          {/* ── Agents ── */}
          <div className="h-section">{t('Агенты', 'Agents')}</div>
          <div className="panel">
            {agents.length === 0 && <div className="empty">{t('Нет зарегистрированных агентов', 'No agents registered')}</div>}
            {agents.map(a => (
              <div key={a.id} className="agent-row">
                <div className="agent-name-col">
                  <DotStatus status={a.status} />
                  <div>
                    <div className="agent-name">{a.name}</div>
                    <div className="agent-id">{a.id}{a.model ? ` · ${a.model}` : ''}</div>
                  </div>
                </div>
                <div className="agent-meta">
                  {a.lifecycle?.status && (
                    <div>
                      <span className={`status-dot ${a.lifecycle.status === 'running' ? 'dot-blue' : a.lifecycle.status === 'error' ? 'dot-red' : 'dot-gray'}`} style={{ width: 7, height: 7, marginRight: 4 }} />
                      {LIFECYCLE_LABELS[a.lifecycle.status] ?? a.lifecycle.status}
                    </div>
                  )}
                  {a.lastHeartbeat && (
                    <div style={{ marginTop: 2 }}>{new Date(a.lastHeartbeat).toLocaleTimeString()}</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* ── System ── */}
          <div className="h-section">{t('Система', 'System')}</div>
          <div className="grid3">
            <div className="panel">
              <h2>{t('Состояние API', 'API Health')}</h2>
              <div className="kv">
                <span className="kv-key">API</span>
                <span className={apiHealth?.status === 'ok' ? 'status-ok' : 'status-err'}>
                  {apiHealth?.status === 'ok' ? '✓ OK' : apiHealth ? '✗ Error' : '…'}
                </span>
              </div>
              <div className="kv">
                <span className="kv-key">{t('Время сервера', 'Server time')}</span>
                <span className="kv-val">{apiHealth?.ts ? new Date(apiHealth.ts).toLocaleString() : '-'}</span>
              </div>
              <div className="kv">
                <span className="kv-key">{t('Агентов онлайн', 'Agents online')}</span>
                <span className="kv-val">{online} / {agents.length}</span>
              </div>
            </div>

            <div className="panel">
              <h2>{t('Коннекторы', 'Connectors')}</h2>
              {adapters.length === 0 && <div className="empty">{t('Адаптеры не зарегистрированы', 'No adapters registered')}</div>}
              {adapters.map(name => {
                const h = adapterHealth[name];
                return (
                  <div className="adapter-row" key={name}>
                    <span style={{ fontWeight: 500 }}>{name}</span>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {h === true && <span className="status-ok">✓ OK</span>}
                      {h === false && <span className="status-err">✗ {t('Ошибка', 'Error')}</span>}
                      {(h === null || h === undefined) && <span style={{ color: '#9ca3af' }}>–</span>}
                      <button className="check-btn" onClick={() => checkAdapter(name)}>{t('Проверить', 'Check')}</button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="panel">
              <h2>{t('Telegram streams', 'Telegram streams')}</h2>
              {!telegramStreams && <div className="empty">{t('Нет данных', 'No data')}</div>}
              {telegramStreams && (
                <>
                  <div className="kv">
                    <span className="kv-key">{t('Итоговый статус', 'Overall status')}</span>
                    <span className={`status-pill ${streamStatusClass(telegramStreams.status)}`}>{telegramStreams.status}</span>
                  </div>
                  <table className="stream-table">
                    <thead>
                      <tr>
                        <th>{t('Поток', 'Stream')}</th>
                        <th>{t('Группа', 'Group')}</th>
                        <th>{t('Lag', 'Lag')}</th>
                        <th>{t('Pending', 'Pending')}</th>
                        <th>{t('Статус', 'Status')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {telegramStreams.streams.flatMap(stream => stream.groups.map(group => (
                        <tr key={`${stream.stream}:${group.group}`}>
                          <td className="stream-code">{stream.stream}<div style={{ color: '#94a3b8' }}>len={stream.length}</div></td>
                          <td className="stream-code">{group.group}<div style={{ color: '#94a3b8' }}>consumers={group.consumers}</div></td>
                          <td>{group.lag}</td>
                          <td>{group.pending}</td>
                          <td><span className={`status-pill ${streamStatusClass(group.status)}`}>{group.status}</span></td>
                        </tr>
                      )))}
                    </tbody>
                  </table>
                  <div style={{ marginTop: 10, fontSize: 12, color: '#64748b' }}>
                    {t('Dead letters:', 'Dead letters:')} {telegramStreams.dead_letters.map(item => `${item.stream}=${item.length}`).join(', ')}
                  </div>
                  <div className="refresh-info">
                    warn lag &gt; {telegramStreams.thresholds.warn_lag}, warn pending &gt; {telegramStreams.thresholds.warn_pending}, fail pending ≥ {telegramStreams.thresholds.fail_pending}
                  </div>
                </>
              )}
            </div>

            <div className="panel">
              <h2>{t('Действия', 'Actions')}</h2>
              <button className="action-btn" onClick={() => adapters.forEach(n => checkAdapter(n))}>
                ↺ {t('Проверить все коннекторы', 'Check all connectors')}
              </button>
              <button className="action-btn" onClick={load}>
                ↺ {t('Обновить', 'Refresh')}
              </button>
              <button className="action-btn danger" onClick={async () => {
                if (!confirm(t('Удалить ВСЕ рабочие задачи? Это действие необратимо.', 'Delete ALL work items? This cannot be undone.'))) return;
                try { await api.workitems.deleteAll(); alert(t('Все задачи удалены.', 'All work items deleted.')); load(); }
                catch (e: any) { alert('Error: ' + e.message); }
              }}>
                🗑 {t('Очистить все задачи', 'Clear all work items')}
              </button>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
