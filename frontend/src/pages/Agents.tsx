import { useState, useCallback } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { Agent } from '../api/types';

const styles = `
  .ag-body { padding: 20px; }
  .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .page-header h1 { color: #333; font-size: 24px; }
  .btn-new { padding: 8px 18px; background: #6366f1; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; }
  .btn-new:hover { background: #4f46e5; }
  .table { width: 100%; border-collapse: collapse; }
  .table th { background: #f9f9f9; padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #666; border-bottom: 2px solid #eee; text-transform: uppercase; }
  .table td { padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; vertical-align: middle; }
  .table tr:hover td { background: #fafafa; }
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot-online { background: #10b981; }
  .dot-offline { background: #9ca3af; }
  .dot-running { background: #3b82f6; }
  .dot-error { background: #ef4444; }
  .dot-starting { background: #f59e0b; }
  .dot-stopped { background: #9ca3af; }
  .actions { display: flex; gap: 5px; flex-wrap: wrap; }
  .actions button { padding: 4px 10px; border: 1px solid #ddd; background: white; border-radius: 3px; cursor: pointer; font-size: 12px; font-weight: 500; }
  .actions button:hover { background: #f0f0f0; }
  .actions .btn-start { background: #10b981; color: white; border-color: #10b981; }
  .actions .btn-start:hover { background: #059669; }
  .actions .btn-stop { background: #f59e0b; color: white; border-color: #f59e0b; }
  .actions .btn-stop:hover { background: #d97706; }
  .actions .btn-restart { background: #3b82f6; color: white; border-color: #3b82f6; }
  .actions .btn-restart:hover { background: #2563eb; }
  .actions .btn-del { background: #ef4444; color: white; border-color: #ef4444; }
  .actions .btn-del:hover { background: #dc2626; }
  .tag { display: inline-block; padding: 1px 6px; background: #f1f5f9; border-radius: 10px; font-size: 11px; color: #475569; margin: 1px; }
  .badge-system { display: inline-block; padding: 1px 7px; background: #ede9fe; color: #5b21b6; border-radius: 8px; font-size: 10px; font-weight: 600; margin-left: 6px; vertical-align: middle; }
  .badge-external { display: inline-block; padding: 1px 7px; background: #fff7ed; color: #92400e; border-radius: 8px; font-size: 10px; font-weight: 600; margin-left: 6px; vertical-align: middle; }
  .badge-managed { display: inline-block; padding: 1px 7px; background: #f0fdf4; color: #166534; border-radius: 8px; font-size: 10px; font-weight: 600; margin-left: 6px; vertical-align: middle; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }
  .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.5); z-index: 1000; display: flex; justify-content: center; align-items: center; }
  .modal { background: white; border-radius: 8px; padding: 24px; width: 480px; max-width: 95vw; box-shadow: 0 20px 25px rgba(0,0,0,.15); }
  .modal h2 { margin-bottom: 18px; color: #333; }
  .form-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
  .form-group label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; }
  .form-group input, .form-group select, .form-group textarea { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .form-group input:focus, .form-group select:focus, .form-group textarea:focus { outline: none; border-color: #6366f1; }
  .form-group textarea { resize: vertical; min-height: 80px; }
  .form-group textarea[readonly] { background: #f8fafc; color: #475569; cursor: default; }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .form-actions button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .btn-submit { background: #6366f1; color: white; }
  .btn-submit:hover { background: #4f46e5; }
  .btn-cancel-f { background: #e5e7eb; color: #374151; }
  .uptime { font-size: 12px; color: #888; }
  .refresh-info { font-size: 12px; color: #999; margin-top: 12px; text-align: right; }
`;

function lifecycleColor(lc?: { status: string }): string {
  const s = lc?.status || '';
  if (s === 'running') return 'dot-running';
  if (s === 'starting') return 'dot-starting';
  if (s === 'error') return 'dot-error';
  if (s === 'stopped') return 'dot-stopped';
  return 'dot-offline';
}

function busColor(status: string): string {
  if (status === 'online') return 'dot-online';
  return 'dot-offline';
}

function formatUptime(sec?: number): string {
  if (!sec) return '';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

const SYSTEM_IDS = new Set(['naruto', 'sasuke', 'kakashi']);
type AgentType = 'system' | 'external' | 'managed';

function getAgentType(a: Agent): AgentType {
  if (SYSTEM_IDS.has(a.id)) return 'system';
  if (a.village_id && a.village_id !== 'comind.konoha') return 'external';
  return 'managed';
}

function AgentTypeBadge({ type }: { type: AgentType }) {
  if (type === 'system')   return <span className="badge-system">Системный</span>;
  if (type === 'external') return <span className="badge-external">Внешний</span>;
  return <span className="badge-managed">Управляемый</span>;
}

interface NewAgentModalProps { onClose: () => void; onCreated: () => void; }
function NewAgentModal({ onClose, onCreated }: NewAgentModalProps) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!id.trim() || !name.trim()) { setError('ID and name are required'); return; }
    setSubmitting(true); setError(null);
    try {
      await api.agents.create({ id: id.trim(), name: name.trim(), model, system_prompt: prompt || undefined });
      onCreated(); onClose();
    } catch (err: any) { setError(err.message); setSubmitting(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>New Agent</h2>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={submit}>
          <div className="form-group">
            <label>Agent ID *</label>
            <input type="text" placeholder="e.g. my-agent" value={id} onChange={e => setId(e.target.value)} autoFocus required />
          </div>
          <div className="form-group">
            <label>Name *</label>
            <input type="text" placeholder="Display name..." value={name} onChange={e => setName(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Model</label>
            <select value={model} onChange={e => setModel(e.target.value)}>
              <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
              <option value="claude-opus-4-6">claude-opus-4-6</option>
              <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</option>
            </select>
          </div>
          <div className="form-group">
            <div style={{ padding: '8px 10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 4, marginBottom: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: 2 }}>Системные инструкции (Layer 1)</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>Авто-инжектируются Konoha при старте: регистрация, watchdog, память. Не редактируются.</div>
            </div>
            <label>Пользовательские инструкции (Layer 2)</label>
            <textarea placeholder="Роль, специализация, типы задач, поведение..." value={prompt} onChange={e => setPrompt(e.target.value)} />
          </div>
          <div className="form-actions">
            <button type="button" className="btn-cancel-f" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-submit" disabled={submitting}>{submitting ? 'Creating...' : 'Create'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

import { useEffect } from 'react';

interface TmuxModalProps { agentId: string; onClose: () => void; }
function TmuxModal({ agentId, onClose }: TmuxModalProps) {
  const [lines, setLines] = useState('Loading...');
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    api.agents.tmuxLog(agentId)
      .then(d => setLines(d.lines || '(empty)'))
      .catch(e => setLines('Error: ' + e.message));
    return () => document.removeEventListener('keydown', h);
  }, [agentId, onClose]);
  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 700, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ fontSize: 16 }}>tmux: {agentId}</h2>
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#888' }} onClick={onClose}>×</button>
        </div>
        <pre style={{ flex: 1, overflow: 'auto', background: '#0d1117', color: '#e6edf3', padding: 16, borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{lines}</pre>
      </div>
    </div>
  );
}

interface EditAgentModalProps { agent: Agent; onClose: () => void; onSaved: () => void; }
function EditAgentModal({ agent, onClose, onSaved }: EditAgentModalProps) {
  const [name, setName] = useState(agent.name);
  const [model, setModel] = useState(agent.model || 'claude-sonnet-4-6');
  const [prompt, setPrompt] = useState((agent as any).system_prompt || '');
  const [sysTemplate, setSysTemplate] = useState<string | null>(null);
  const [sysExpanded, setSysExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Load full agent data (system_prompt may not be in list response)
    api.agents.get(agent.id)
      .then(d => { setPrompt((d as any).system_prompt || ''); })
      .catch(() => {});
    // Load system template
    api.agents.systemTemplate(agent.id)
      .then(d => setSysTemplate(d.template))
      .catch(() => {});
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [agent.id, onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true); setError(null);
    try {
      await api.agents.update(agent.id, { name: name.trim(), model, system_prompt: prompt });
      onSaved(); onClose();
    } catch (err: any) { setError(err.message); setSubmitting(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 580 }}>
        <h2>Edit Agent — {agent.id}</h2>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={submit}>
          <div className="form-group">
            <label>Name *</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} required autoFocus />
          </div>
          <div className="form-group">
            <label>Model</label>
            <select value={model} onChange={e => setModel(e.target.value)}>
              <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
              <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</option>
              <option value="claude-opus-4-6">claude-opus-4-6</option>
            </select>
          </div>
          {sysTemplate !== null && (
            <div className="form-group">
              <div
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none', padding: '6px 0' }}
                onClick={() => setSysExpanded(v => !v)}
              >
                <label style={{ cursor: 'pointer', color: '#64748b', marginBottom: 0 }}>Системные инструкции (управляются Konoha)</label>
                <span style={{ fontSize: 12, color: '#94a3b8', flexShrink: 0 }}>{sysExpanded ? '▲ Свернуть' : '▼ Развернуть'}</span>
              </div>
              {sysExpanded && (
                <textarea
                  readOnly
                  value={sysTemplate}
                  style={{ minHeight: 160, background: '#f8fafc', color: '#475569', fontFamily: 'monospace', fontSize: 12, resize: 'vertical', border: '1px solid #e2e8f0', cursor: 'default' }}
                />
              )}
            </div>
          )}
          <div className="form-group">
            <label>Пользовательские инструкции</label>
            <textarea
              placeholder="Роль, специализация, типы задач, поведение..."
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              style={{ minHeight: 180 }}
            />
          </div>
          <div className="form-actions">
            <button type="button" className="btn-cancel-f" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-submit" disabled={submitting}>{submitting ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function Agents() {
  const token = useToken();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState('-');
  const [showNew, setShowNew] = useState(false);
  const [tmuxAgent, setTmuxAgent] = useState<string | null>(null);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    api.agents.list()
      .then(data => { setAgents(data); setLastUpdate(new Date().toLocaleTimeString()); setError(null); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 10000);

  async function action(id: string, fn: () => Promise<unknown>, label: string) {
    if (label === 'Delete' && !confirm(`Delete agent "${id}"? This cannot be undone.`)) return;
    try { await fn(); load(); } catch (e: any) { setError(e.message); }
  }

  return (
    <Layout activePage="agents.html">
      <style>{styles}</style>
      <div className="ag-body">
        <div className="container">
          <div className="page-header">
            <h1>Agents</h1>
            <button className="btn-new" onClick={() => setShowNew(true)}>+ New Agent</button>
          </div>
          {error && <div className="error-banner">{error}</div>}
          {loading && <div className="empty">Loading...</div>}
          {!loading && agents.length === 0 && <div className="empty">No agents registered.</div>}
          {agents.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Bus Status</th>
                  <th>Lifecycle</th>
                  <th>Model</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {agents.map(a => {
                  const atype = getAgentType(a);
                  const canEdit = atype === 'managed';
                  return (
                  <tr key={a.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>
                        {a.name}
                        <AgentTypeBadge type={atype} />
                      </div>
                      <div style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>{a.id}</div>
                    </td>
                    <td>
                      <span className={`status-dot ${busColor(a.status)}`} />
                      {a.status}
                    </td>
                    <td>
                      {a.lifecycle ? (
                        <>
                          <span className={`status-dot ${lifecycleColor(a.lifecycle)}`} />
                          {a.lifecycle.status}
                          {a.lifecycle.uptime_seconds ? (
                            <div className="uptime">{formatUptime(a.lifecycle.uptime_seconds)}</div>
                          ) : null}
                        </>
                      ) : '-'}
                    </td>
                    <td style={{ fontSize: 12, color: '#555' }}>{a.model || '-'}</td>
                    <td>
                      <div className="actions">
                        {canEdit && a.lifecycle && <>
                          <button className="btn-start" onClick={() => action(a.id, () => api.agents.start(a.id), 'Start')}>▶ Start</button>
                          <button className="btn-stop" onClick={() => action(a.id, () => api.agents.stop(a.id), 'Stop')}>■ Stop</button>
                          <button className="btn-restart" onClick={() => action(a.id, () => api.agents.restart(a.id), 'Restart')}>↺</button>
                          <button onClick={() => setEditAgent(a)}>Edit</button>
                        </>}
                        <button onClick={() => setTmuxAgent(a.id)}>Logs</button>
                        {canEdit && <button className="btn-del" onClick={() => action(a.id, () => api.agents.delete(a.id), 'Delete')}>🗑</button>}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="refresh-info">Auto-refresh 10s • Last: {lastUpdate}</div>
        </div>
      </div>
      {showNew && <NewAgentModal onClose={() => setShowNew(false)} onCreated={load} />}
      {tmuxAgent && <TmuxModal agentId={tmuxAgent} onClose={() => setTmuxAgent(null)} />}
      {editAgent && <EditAgentModal agent={editAgent} onClose={() => setEditAgent(null)} onSaved={load} />}
    </Layout>
  );
}
