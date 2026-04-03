import { useState, useCallback } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { Agent, Skill } from '../api/types';
import { KibaPanel, KIBA_CSS } from '../components/KibaPanel';

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
  .ag-filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; padding: 10px 12px; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0; }
  .ag-filter-input { padding: 5px 10px; border: 1px solid #e2e8f0; border-radius: 5px; font-size: 13px; background: white; }
  .ag-filter-input:focus { outline: none; border-color: #6366f1; }
  .ag-filter-select { padding: 5px 10px; border: 1px solid #e2e8f0; border-radius: 5px; font-size: 13px; background: white; cursor: pointer; }
  .ag-filter-select:focus { outline: none; border-color: #6366f1; }
  .ag-filter-label { font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: .04em; }
`;

function lifecycleColor(lc?: { status: string }): string {
  const s = lc?.status || '';
  if (s === 'running') return 'dot-running';
  if (s === 'starting') return 'dot-starting';
  if (s === 'error') return 'dot-error';
  if (s === 'stopped') return 'dot-stopped';
  return 'dot-offline';
}

const BUS_STATUS_LABELS: Record<string, string> = {
  online: 'онлайн',
  offline: 'офлайн',
};

const LIFECYCLE_STATUS_LABELS: Record<string, string> = {
  running: 'работает',
  starting: 'запускается',
  stopped: 'остановлен',
  error: 'ошибка',
};

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
    if (!id.trim() || !name.trim()) { setError('Укажите ID и имя'); return; }
    setSubmitting(true); setError(null);
    try {
      await api.agents.create({ id: id.trim(), name: name.trim(), model, system_prompt: prompt || undefined });
      onCreated(); onClose();
    } catch (err: any) { setError(err.message); setSubmitting(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>Новый агент</h2>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={submit}>
          <div className="form-group">
            <label>ID агента *</label>
            <input type="text" placeholder="например: my-agent" value={id} onChange={e => setId(e.target.value)} autoFocus required />
          </div>
          <div className="form-group">
            <label>Имя *</label>
            <input type="text" placeholder="Отображаемое имя..." value={name} onChange={e => setName(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Модель</label>
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
            <button type="button" className="btn-cancel-f" onClick={onClose}>Отмена</button>
            <button type="submit" className="btn-submit" disabled={submitting}>{submitting ? 'Создание…' : 'Создать'}</button>
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
  const [tab, setTab] = useState<'settings' | 'memory'>('settings');
  const [name, setName] = useState(agent.name);
  const [model, setModel] = useState(agent.model || 'claude-sonnet-4-6');
  const [prompt, setPrompt] = useState((agent as any).system_prompt || '');
  const [sysTemplate, setSysTemplate] = useState<string | null>(null);
  const [sysExpanded, setSysExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memFiles, setMemFiles] = useState<{ name: string; size: number; updated_at: string }[]>([]);
  const [memContent, setMemContent] = useState<{ name: string; text: string } | null>(null);
  const [memLoading, setMemLoading] = useState(false);
  const [allSkills, setAllSkills] = useState<Skill[]>([]);
  const [capabilities, setCapabilities] = useState<string[]>((agent as any).capabilities || []);
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>((agent as any).avatar_url);
  const [avatarStyle, setAvatarStyle] = useState('anime ninja');
  const [generatingAvatar, setGeneratingAvatar] = useState(false);
  const [gender, setGender] = useState<'male' | 'female' | 'neutral'>((agent as any).gender || 'neutral');

  useEffect(() => {
    api.agents.get(agent.id).then(d => {
      setPrompt((d as any).system_prompt || '');
      setCapabilities((d as any).capabilities || []);
      setAvatarUrl((d as any).avatar_url);
    }).catch(() => {});
    api.agents.systemTemplate(agent.id).then(d => setSysTemplate(d.template)).catch(() => {});
    api.skills.list().then(setAllSkills).catch(() => {});
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [agent.id, onClose]);

  function loadMemory() {
    setMemLoading(true);
    api.agents.memoryList(agent.id)
      .then(files => { setMemFiles(files); setMemLoading(false); })
      .catch(() => setMemLoading(false));
  }

  useEffect(() => { if (tab === 'memory') loadMemory(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  async function openFile(filename: string) {
    const text = await api.agents.memoryRead(agent.id, filename).catch(() => '(ошибка чтения)');
    setMemContent({ name: filename, text });
  }

  async function deleteFile(filename: string) {
    if (!confirm(`Удалить файл памяти "${filename}"?`)) return;
    await api.agents.memoryDelete(agent.id, filename).catch(() => {});
    setMemContent(null);
    loadMemory();
  }

  function toggleCapability(id: string) {
    setCapabilities(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);
  }

  async function doGenerateAvatar() {
    setGeneratingAvatar(true);
    try {
      const res = await api.agents.generateAvatar(agent.id, { style: avatarStyle, description: prompt.slice(0, 100) || undefined });
      setAvatarUrl(res.avatar_url);
    } catch (e: any) {
      setError(`Аватар: ${e.message}`);
    } finally {
      setGeneratingAvatar(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true); setError(null);
    try {
      await api.agents.update(agent.id, { name: name.trim(), model, system_prompt: prompt, capabilities, gender });
      onSaved(); onClose();
    } catch (err: any) { setError(err.message); setSubmitting(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 620, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <h2 style={{ marginBottom: 12 }}>Изменить агента — {agent.id}</h2>
        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #e2e8f0', paddingBottom: 8 }}>
          {(['settings', 'memory'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: '5px 14px', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600,
              background: tab === t ? '#6366f1' : '#f1f5f9', color: tab === t ? 'white' : '#475569',
            }}>
              {t === 'settings' ? 'Настройки' : 'Память'}
            </button>
          ))}
        </div>
        {error && <div className="error-banner">{error}</div>}

        {tab === 'settings' && (
          <form onSubmit={submit} style={{ overflowY: 'auto', flex: 1 }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
              <div style={{ flexShrink: 0 }}>
                {avatarUrl
                  ? <img src={avatarUrl} alt="avatar" style={{ width: 72, height: 72, borderRadius: 8, objectFit: 'cover', border: '2px solid #e2e8f0' }} />
                  : <div style={{ width: 72, height: 72, borderRadius: 8, background: '#6366f1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, color: 'white', fontWeight: 700, border: '2px solid #e2e8f0', userSelect: 'none' }}>
                      {name.charAt(0).toUpperCase() || agent.id.charAt(0).toUpperCase()}
                    </div>
                }
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Аватар</div>
                <input
                  type="text"
                  value={avatarStyle}
                  onChange={e => setAvatarStyle(e.target.value)}
                  placeholder="anime ninja, pixel art, portrait…"
                  style={{ padding: '5px 10px', border: '1px solid #ddd', borderRadius: 4, fontSize: 13 }}
                />
                <button
                  type="button"
                  onClick={doGenerateAvatar}
                  disabled={generatingAvatar}
                  style={{ padding: '5px 12px', background: '#6366f1', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: generatingAvatar ? 0.6 : 1 }}
                >
                  {generatingAvatar ? '⏳ Генерируется…' : '✨ Сгенерировать аватар'}
                </button>
              </div>
            </div>
            <div className="form-group">
              <label>Имя *</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} required autoFocus />
            </div>
            <div className="form-group">
              <label>Модель</label>
              <select value={model} onChange={e => setModel(e.target.value)}>
                <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</option>
                <option value="claude-opus-4-6">claude-opus-4-6</option>
              </select>
            </div>
            <div className="form-group">
              <label>Род</label>
              <select value={gender} onChange={e => setGender(e.target.value as 'male' | 'female' | 'neutral')}>
                <option value="neutral">Средний (они)</option>
                <option value="male">Мужской (он)</option>
                <option value="female">Женский (она)</option>
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
                  <textarea readOnly value={sysTemplate}
                    style={{ minHeight: 160, background: '#f8fafc', color: '#475569', fontFamily: 'monospace', fontSize: 12, resize: 'vertical', border: '1px solid #e2e8f0', cursor: 'default' }}
                  />
                )}
              </div>
            )}
            <div className="form-group">
              <label>Пользовательские инструкции</label>
              <textarea placeholder="Роль, специализация, типы задач, поведение..."
                value={prompt} onChange={e => setPrompt(e.target.value)} style={{ minHeight: 180 }} />
            </div>
            {allSkills.length > 0 && (
              <div className="form-group">
                <label>Навыки / Capabilities</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 0' }}>
                  {allSkills.map(s => (
                    <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 10px', border: `1px solid ${capabilities.includes(s.id) ? '#6366f1' : '#ddd'}`, borderRadius: 16, cursor: 'pointer', fontSize: 13, background: capabilities.includes(s.id) ? '#ede9fe' : 'white', color: capabilities.includes(s.id) ? '#4f46e5' : '#374151', userSelect: 'none' }}>
                      <input type="checkbox" checked={capabilities.includes(s.id)} onChange={() => toggleCapability(s.id)} style={{ display: 'none' }} />
                      {capabilities.includes(s.id) ? '✓ ' : ''}{s.name}
                    </label>
                  ))}
                </div>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>Prompt snippet навыков инжектируется в CLAUDE.md при старте агента</span>
              </div>
            )}
            <div className="form-actions">
              <button type="button" className="btn-cancel-f" onClick={onClose}>Отмена</button>
              <button type="submit" className="btn-submit" disabled={submitting}>{submitting ? 'Сохранение…' : 'Сохранить'}</button>
            </div>
          </form>
        )}

        {tab === 'memory' && (
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {memLoading && <div style={{ color: '#94a3b8', fontSize: 13, padding: '12px 0' }}>Загрузка…</div>}
            {!memLoading && memFiles.length === 0 && (
              <div style={{ color: '#94a3b8', fontSize: 13, padding: '12px 0' }}>Память пуста.</div>
            )}
            {!memLoading && memFiles.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                {memFiles.map(f => (
                  <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 4, cursor: 'pointer', background: memContent?.name === f.name ? '#eff6ff' : 'transparent' }}
                    onMouseEnter={e => { if (memContent?.name !== f.name) (e.currentTarget as HTMLDivElement).style.background = '#f8fafc'; }}
                    onMouseLeave={e => { if (memContent?.name !== f.name) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}>
                    <span style={{ flex: 1, fontSize: 13, fontFamily: 'monospace', color: '#334155', cursor: 'pointer' }} onClick={() => openFile(f.name)}>{f.name}</span>
                    <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0 }}>{(f.size / 1024).toFixed(1)} KB</span>
                    <button onClick={() => deleteFile(f.name)} style={{ padding: '2px 6px', fontSize: 11, border: '1px solid #fca5a5', background: 'white', color: '#ef4444', borderRadius: 3, cursor: 'pointer' }}>✕</button>
                  </div>
                ))}
              </div>
            )}
            {memContent && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b', fontFamily: 'monospace' }}>{memContent.name}</span>
                  <button onClick={() => setMemContent(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 16 }}>×</button>
                </div>
                <textarea readOnly value={memContent.text} style={{ width: '100%', minHeight: 240, fontFamily: 'monospace', fontSize: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 4, padding: 10, resize: 'vertical', color: '#334155', cursor: 'default', boxSizing: 'border-box' }} />
              </div>
            )}
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn-cancel-f" onClick={onClose}>Закрыть</button>
            </div>
          </div>
        )}
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
  const [showKiba, setShowKiba] = useState(false);
  // Filters & sort
  const [search, setSearch] = useState('');
  const [filterBus, setFilterBus] = useState('all');
  const [filterLifecycle, setFilterLifecycle] = useState('all');
  const [filterModel, setFilterModel] = useState('all');
  const [sortBy, setSortBy] = useState<'name' | 'status' | 'model'>('name');

  const load = useCallback(() => {
    if (!token) return;
    api.agents.list()
      .then(data => { setAgents(data); setLastUpdate(new Date().toLocaleTimeString()); setError(null); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 10000);

  async function action(id: string, fn: () => Promise<unknown>, label: string) {
    if (label === 'Delete' && !confirm(`Удалить агента "${id}"? Это действие необратимо.`)) return;
    try { await fn(); load(); } catch (e: any) { setError(e.message); }
  }

  const allModels = [...new Set(agents.map(a => a.model).filter(Boolean))] as string[];

  const filteredAgents = agents
    .filter(a => {
      if (search && !a.name.toLowerCase().includes(search.toLowerCase()) && !a.id.toLowerCase().includes(search.toLowerCase())) return false;
      if (filterBus !== 'all' && a.status !== filterBus) return false;
      if (filterLifecycle !== 'all') {
        const ls = (a.lifecycle as any)?.status;
        if (filterLifecycle === 'none' ? ls : ls !== filterLifecycle) return false;
      }
      if (filterModel !== 'all' && a.model !== filterModel) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'model') return (a.model || '').localeCompare(b.model || '');
      if (sortBy === 'status') return a.status.localeCompare(b.status);
      return 0;
    });

  return (
    <Layout activePage="agents.html">
      <style>{styles + KIBA_CSS}</style>
      <div style={{ display: 'flex', height: 'calc(100vh - 105px)' }}>
      <div className="ag-body" style={{ flex: 1, overflowY: 'auto' }}>
        <div className="container">
          <div className="page-header">
            <h1>Агенты</h1>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-new" onClick={() => setShowNew(true)}>+ Новый агент</button>
              <button style={{ padding: '8px 14px', background: showKiba ? '#4f46e5' : '#1e293b', color: 'white', border: '1px solid #6366f1', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600 }} onClick={() => setShowKiba(v => !v)}>🐕 Киба</button>
            </div>
          </div>
          {error && <div className="error-banner">{error}</div>}
          {loading && <div className="empty">Загрузка…</div>}
          {!loading && (
            <div className="ag-filters">
              <span className="ag-filter-label">Поиск:</span>
              <input className="ag-filter-input" placeholder="Имя или ID…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 160 }} />
              <span className="ag-filter-label">Шина:</span>
              <select className="ag-filter-select" value={filterBus} onChange={e => setFilterBus(e.target.value)}>
                <option value="all">Все</option>
                <option value="online">Онлайн</option>
                <option value="offline">Офлайн</option>
              </select>
              <span className="ag-filter-label">Процесс:</span>
              <select className="ag-filter-select" value={filterLifecycle} onChange={e => setFilterLifecycle(e.target.value)}>
                <option value="all">Все</option>
                <option value="running">Запущен</option>
                <option value="stopped">Остановлен</option>
                <option value="error">Ошибка</option>
                <option value="none">Нет процесса</option>
              </select>
              {allModels.length > 1 && <>
                <span className="ag-filter-label">Модель:</span>
                <select className="ag-filter-select" value={filterModel} onChange={e => setFilterModel(e.target.value)}>
                  <option value="all">Все</option>
                  {allModels.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </>}
              <span className="ag-filter-label">Сортировка:</span>
              <select className="ag-filter-select" value={sortBy} onChange={e => setSortBy(e.target.value as any)}>
                <option value="name">По имени</option>
                <option value="status">По статусу</option>
                <option value="model">По модели</option>
              </select>
              {filteredAgents.length !== agents.length && (
                <span style={{ fontSize: 12, color: '#6366f1', marginLeft: 4 }}>{filteredAgents.length} из {agents.length}</span>
              )}
            </div>
          )}
          {!loading && agents.length === 0 && <div className="empty">Агенты не зарегистрированы.</div>}
          {agents.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Агент</th>
                  <th>Шина</th>
                  <th>Процесс</th>
                  <th>Модель</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {filteredAgents.map(a => {
                  const atype = getAgentType(a);
                  const canEdit = atype === 'managed';
                  return (
                  <tr key={a.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {(a as any).avatar_url
                          ? <img src={(a as any).avatar_url} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} />
                          : <div style={{ width: 36, height: 36, borderRadius: 6, background: '#6366f1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: 'white', fontWeight: 700, flexShrink: 0 }}>{a.name.charAt(0).toUpperCase()}</div>
                        }
                        <div>
                          <div style={{ fontWeight: 600 }}>
                            {a.name}
                            <AgentTypeBadge type={atype} />
                          </div>
                          <div style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>{a.id}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`status-dot ${busColor(a.status)}`} />
                      {BUS_STATUS_LABELS[a.status] ?? a.status}
                    </td>
                    <td>
                      {a.lifecycle ? (
                        <>
                          <span className={`status-dot ${lifecycleColor(a.lifecycle)}`} />
                          {LIFECYCLE_STATUS_LABELS[a.lifecycle.status] ?? a.lifecycle.status}
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
                          <button className="btn-start" onClick={() => action(a.id, () => api.agents.start(a.id), 'Start')}>▶ Запустить</button>
                          <button className="btn-stop" onClick={() => action(a.id, () => api.agents.stop(a.id), 'Stop')}>■ Остановить</button>
                          <button className="btn-restart" onClick={() => action(a.id, () => api.agents.restart(a.id), 'Restart')}>↺</button>
                          <button onClick={() => setEditAgent(a)}>Изменить</button>
                        </>}
                        <button onClick={() => setTmuxAgent(a.id)}>Логи</button>
                        {canEdit && <button className="btn-del" onClick={() => action(a.id, () => api.agents.delete(a.id), 'Delete')}>🗑</button>}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="refresh-info">Авто-обновление 10с • Последнее: {lastUpdate}</div>
        </div>
      </div>
      {showKiba && (
        <KibaPanel
          page="agents"
          contextData={agents}
          onClose={() => setShowKiba(false)}
          onActionDone={load}
        />
      )}
      </div>
      {showNew && <NewAgentModal onClose={() => setShowNew(false)} onCreated={load} />}
      {tmuxAgent && <TmuxModal agentId={tmuxAgent} onClose={() => setTmuxAgent(null)} />}
      {editAgent && <EditAgentModal agent={editAgent} onClose={() => setEditAgent(null)} onSaved={load} />}
    </Layout>
  );
}
