import { useState, useCallback, useEffect } from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { Agent } from '../api/types';

interface BusStatus { status: string; ts: string; }

const styles = `
  .adm-body { padding: 20px; }
  .container { max-width: 1200px; margin: 0 auto; }
  h1 { color: #333; font-size: 24px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .panel { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .panel h2 { font-size: 16px; font-weight: 700; color: #1e293b; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid #eee; }
  .metric-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
  .metric-row:last-child { border-bottom: none; }
  .metric-label { color: #64748b; }
  .metric-value { font-weight: 600; color: #1e293b; font-family: monospace; }
  .status-ok { color: #10b981; font-weight: 600; }
  .status-err { color: #ef4444; font-weight: 600; }
  .status-unknown { color: #9ca3af; }
  .agent-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
  .agent-row:last-child { border-bottom: none; }
  .agent-name { font-weight: 600; }
  .agent-id { font-size: 11px; color: #888; font-family: monospace; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
  .dot-green { background: #10b981; }
  .dot-gray { background: #9ca3af; }
  .dot-red { background: #ef4444; }
  .dot-blue { background: #3b82f6; }
  .refresh-info { font-size: 12px; color: #999; margin-top: 8px; text-align: right; }
  .error-banner { background: #fee; color: #c33; padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }
  .adapter-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
  .check-btn { padding: 3px 8px; border: 1px solid #ddd; background: white; border-radius: 3px; cursor: pointer; font-size: 11px; }
  .section-title { font-size: 18px; font-weight: 700; color: #1e293b; margin: 28px 0 14px; }
  .big-status { text-align: center; padding: 8px 0 12px; }
  .big-dot { display: inline-block; width: 14px; height: 14px; border-radius: 50%; margin-bottom: 6px; }
  .big-label { font-size: 18px; font-weight: 700; }
  .big-ts { font-size: 12px; color: #888; margin-top: 4px; }
  .status-dot-sm { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
  .dot-green { background: #10b981; }
  .dot-gray { background: #9ca3af; }
  .dot-red { background: #ef4444; }
  .dot-blue { background: #3b82f6; }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
`;

export function Admin() {
  const token = useToken();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [adapters, setAdapters] = useState<string[]>([]);
  const [adapterHealth, setAdapterHealth] = useState<Record<string, boolean | null>>({});
  const [health, setHealth] = useState<{ status: string; ts: string } | null>(null);
  const [busStatus, setBusStatus] = useState<BusStatus | null>(null);
  const [busError, setBusError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState('-');

  const load = useCallback(() => {
    if (!token) return;
    Promise.all([
      api.agents.list(),
      api.adapters.list(),
      fetch('/api/health').then(r => r.json()),
    ]).then(([ags, adps, hlth]) => {
      setAgents(ags);
      setAdapters(adps.adapters);
      setHealth(hlth);
      setLastUpdate(new Date().toLocaleTimeString());
      setError(null);
    }).catch(e => setError(e.message));
    api.health.bus()
      .then(d => { setBusStatus(d); setBusError(null); })
      .catch(e => setBusError(e.message));
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
  const offline = agents.length - online;
  const running = agents.filter(a => a.lifecycle?.status === 'running').length;

  return (
    <Layout activePage="admin.html">
      <style>{styles}</style>
      <div className="adm-body">
        <div className="container">
          <h1>Admin</h1>
          {error && <div className="error-banner">{error}</div>}

          {/* Health section */}
          <div className="section-title">Health</div>
          <div className="grid">
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
                <div className="big-status"><div className="big-ts">Loading…</div></div>
              )}
            </div>
            <div className="panel">
              <h2>Agent Summary</h2>
              <div className="metric-row">
                <span className="metric-label">Total registered</span>
                <span className="metric-value">{agents.length}</span>
              </div>
              <div className="metric-row">
                <span className="metric-label"><span className="status-dot-sm dot-green" />Online</span>
                <span className="metric-value" style={{ color: '#10b981' }}>{online}</span>
              </div>
              <div className="metric-row">
                <span className="metric-label"><span className="status-dot-sm dot-gray" />Offline</span>
                <span className="metric-value" style={{ color: '#9ca3af' }}>{offline}</span>
              </div>
              <div className="refresh-info">Last: {lastUpdate}</div>
            </div>
          </div>

          <div className="section-title">System</div>
          <div className="grid">

            {/* System Health */}
            <div className="panel">
              <h2>System Health</h2>
              <div className="metric-row">
                <span className="metric-label">API Status</span>
                <span className={health?.status === 'ok' ? 'status-ok' : 'status-err'}>
                  {health?.status === 'ok' ? '✓ OK' : health ? '✗ Error' : '…'}
                </span>
              </div>
              <div className="metric-row">
                <span className="metric-label">Server Time</span>
                <span className="metric-value">{health?.ts ? new Date(health.ts).toLocaleString() : '-'}</span>
              </div>
              <div className="metric-row">
                <span className="metric-label">Agents Online</span>
                <span className="metric-value">{online} / {agents.length}</span>
              </div>
              <div className="metric-row">
                <span className="metric-label">Agents Running (lifecycle)</span>
                <span className="metric-value">{running}</span>
              </div>
              <div className="refresh-info">Last: {lastUpdate}</div>
            </div>

            {/* Bus Monitoring */}
            <div className="panel">
              <h2>Bus — Registered Agents</h2>
              {agents.length === 0 && <div style={{ color: '#999', fontSize: 13 }}>No agents.</div>}
              {agents.map(a => (
                <div className="agent-row" key={a.id}>
                  <div>
                    <div className="agent-name">
                      <span className={`dot ${a.status === 'online' ? 'dot-green' : 'dot-gray'}`} />
                      {a.name}
                    </div>
                    <div className="agent-id">{a.id}</div>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 12, color: '#64748b' }}>
                    {a.lifecycle?.status && (
                      <div>
                        <span className={`dot ${a.lifecycle.status === 'running' ? 'dot-blue' : a.lifecycle.status === 'error' ? 'dot-red' : 'dot-gray'}`} />
                        {a.lifecycle.status}
                      </div>
                    )}
                    {a.lastHeartbeat && (
                      <div style={{ fontSize: 11 }}>{new Date(a.lastHeartbeat).toLocaleTimeString()}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Connectors Health */}
            <div className="panel">
              <h2>Connectors</h2>
              {adapters.length === 0 && <div style={{ color: '#999', fontSize: 13 }}>No adapters registered.</div>}
              {adapters.map(name => {
                const h = adapterHealth[name];
                return (
                  <div className="adapter-row" key={name}>
                    <span style={{ fontWeight: 500, textTransform: 'capitalize' }}>{name}</span>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {h === true && <span className="status-ok">✓ OK</span>}
                      {h === false && <span className="status-err">✗ Error</span>}
                      {h === null || h === undefined ? <span className="status-unknown">–</span> : null}
                      <button className="check-btn" onClick={() => checkAdapter(name)}>Check</button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Quick Actions */}
            <div className="panel">
              <h2>Quick Actions</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <button className="check-btn" style={{ padding: '8px 14px', fontSize: 13, textAlign: 'left' }}
                  onClick={() => { adapters.forEach(n => checkAdapter(n)); }}>
                  ↺ Check all connector health
                </button>
                <button className="check-btn" style={{ padding: '8px 14px', fontSize: 13, textAlign: 'left' }}
                  onClick={load}>
                  ↺ Refresh dashboard
                </button>
              </div>
              <div style={{ marginTop: 20, fontSize: 12, color: '#94a3b8' }}>
                More operational controls (reassign work items, disable agents) coming in future versions.
              </div>
            </div>

          </div>
        </div>
      </div>
    </Layout>
  );
}
