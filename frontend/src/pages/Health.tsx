import { useState, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { Agent } from '../api/types';

const styles = `
  .h-body { padding: 20px; }
  .container { max-width: 1100px; margin: 0 auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-bottom: 20px; }
  .card { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .card h2 { font-size: 16px; font-weight: 700; color: #333; margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }
  .status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .ok { background: #10b981; }
  .warn { background: #f59e0b; }
  .err { background: #ef4444; }
  .offline { background: #9ca3af; }
  .kv { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; }
  .kv:last-child { border-bottom: none; }
  .kv-key { color: #555; }
  .kv-val { font-weight: 600; color: #333; font-family: monospace; font-size: 12px; }
  .agent-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; }
  .agent-row:last-child { border-bottom: none; }
  .agent-name { flex: 1; }
  .agent-model { font-size: 11px; color: #888; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge-online { background: #dcfce7; color: #166534; }
  .badge-offline { background: #f1f5f9; color: #64748b; }
  .badge-error { background: #fee2e2; color: #991b1b; }
  .refresh-info { font-size: 11px; color: #999; text-align: right; margin-top: 8px; }
  .big-status { text-align: center; padding: 8px 0 16px; }
  .big-status .dot { width: 20px; height: 20px; border-radius: 50%; display: inline-block; margin-bottom: 8px; }
  .big-status .label { font-size: 20px; font-weight: 700; }
  .big-status .ts { font-size: 12px; color: #888; margin-top: 4px; }
`;

function agentBadge(status: string) {
  if (status === 'online') return 'badge-online';
  if (status === 'error') return 'badge-error';
  return 'badge-offline';
}

export function Health() {
  const token = useToken();
  const [busStatus, setBusStatus] = useState<{ status: string; ts: string } | null>(null);
  const [busError, setBusError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [lastUpdate, setLastUpdate] = useState('-');

  const load = useCallback(() => {
    if (!token) return;
    api.health.bus()
      .then(d => { setBusStatus(d); setBusError(null); })
      .catch(e => setBusError(e.message));
    api.agents.list()
      .then(d => { setAgents(d); setLastUpdate(new Date().toLocaleTimeString()); })
      .catch(() => {});
  }, [token]);

  useState(() => { load(); });
  useInterval(load, 15000);

  const online = agents.filter(a => a.status === 'online').length;
  const offline = agents.length - online;

  return (
    <Layout activePage="health.html">
      <style>{styles}</style>
      <div className="h-body">
        <div className="container">
          <div className="grid">
            <div className="card">
              <h2>Konoha Bus</h2>
              {busError ? (
                <div className="big-status">
                  <div className="dot err" />
                  <div className="label" style={{ color: '#ef4444' }}>ERROR</div>
                  <div className="ts">{busError}</div>
                </div>
              ) : busStatus ? (
                <div className="big-status">
                  <div className={`dot ${busStatus.status === 'ok' ? 'ok' : 'warn'}`} />
                  <div className="label" style={{ color: busStatus.status === 'ok' ? '#10b981' : '#f59e0b' }}>
                    {busStatus.status.toUpperCase()}
                  </div>
                  <div className="ts">{new Date(busStatus.ts).toLocaleString()}</div>
                </div>
              ) : (
                <div className="big-status"><div className="ts">Loading...</div></div>
              )}
            </div>

            <div className="card">
              <h2>Agent Summary</h2>
              <div className="kv">
                <span className="kv-key">Total registered</span>
                <span className="kv-val">{agents.length}</span>
              </div>
              <div className="kv">
                <span className="kv-key"><span className="status-dot ok" style={{ marginRight: 6 }} />Online</span>
                <span className="kv-val" style={{ color: '#10b981' }}>{online}</span>
              </div>
              <div className="kv">
                <span className="kv-key"><span className="status-dot offline" style={{ marginRight: 6 }} />Offline</span>
                <span className="kv-val" style={{ color: '#9ca3af' }}>{offline}</span>
              </div>
              <div className="refresh-info">Auto-refresh 15s · Last: {lastUpdate}</div>
            </div>
          </div>

          <div className="card">
            <h2>Agents</h2>
            {agents.length === 0 && <div style={{ color: '#999', fontSize: 13, textAlign: 'center', padding: 20 }}>No agents registered</div>}
            {agents.map(a => (
              <div key={a.id} className="agent-row">
                <span className={`status-dot ${a.status === 'online' ? 'ok' : a.status === 'error' ? 'err' : 'offline'}`} />
                <div className="agent-name">
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{a.name}</div>
                  <div className="agent-model">{a.id} {a.model ? `· ${a.model}` : ''}</div>
                </div>
                <span className={`badge ${agentBadge(a.status)}`}>{a.status}</span>
                {a.lifecycle && (
                  <span style={{ fontSize: 11, color: '#888', marginLeft: 8 }}>{a.lifecycle.status}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Layout>
  );
}
