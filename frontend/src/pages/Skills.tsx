import { useState, useCallback, useEffect } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { api } from '../api/client';
import type { Skill, McpServerDef } from '../api/types';

const styles = `
  .skills-body { padding: 20px; }
  .container { max-width: 960px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 12px; }
  .page-header h1 { color: #333; font-size: 24px; }
  .btn-new { padding: 7px 16px; background: #6366f1; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; }
  .btn-new:hover { background: #4f46e5; }
  .table { width: 100%; border-collapse: collapse; }
  .table th { background: #f9f9f9; padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #666; border-bottom: 2px solid #eee; text-transform: uppercase; }
  .table td { padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; vertical-align: top; }
  .table tr:hover td { background: #fafafa; }
  .row-clickable { cursor: pointer; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }
  .skill-id { font-family: monospace; font-size: 12px; color: #6366f1; }
  .skill-desc { color: #64748b; font-size: 13px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .snippet-preview { font-family: monospace; font-size: 11px; color: #475569; background: #f8fafc; padding: 4px 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .search-input { padding: 7px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; width: 220px; }
  .search-input:focus { outline: none; border-color: #6366f1; }
  .tag { display: inline-block; padding: 1px 7px; background: #eff6ff; color: #3730a3; border-radius: 10px; font-size: 11px; margin: 1px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
  .btn-delete { padding: 3px 8px; background: transparent; color: #dc2626; border: 1px solid #fca5a5; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .btn-delete:hover { background: #fee2e2; }
  /* Modal */
  .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.5); z-index: 1000; display: flex; justify-content: center; align-items: center; }
  .modal { background: white; border-radius: 8px; padding: 32px; width: 560px; max-width: 95vw; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 25px rgba(0,0,0,.15); }
  .modal h2 { margin-bottom: 20px; color: #333; }
  .form-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
  .form-group label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; }
  .form-group input, .form-group textarea { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .form-group input:focus, .form-group textarea:focus { outline: none; border-color: #6366f1; }
  .form-hint { font-size: 11px; color: #94a3b8; margin-top: 2px; }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .form-actions button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .btn-submit { background: #6366f1; color: white; }
  .btn-cancel-f { background: #e5e7eb; color: #374151; }
  .mcp-badge { display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px; background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .mcp-json-error { color: #dc2626; font-size: 11px; margin-top: 2px; }
`;

interface SkillModalProps {
  skill?: Skill | null;
  onClose: () => void;
  onSaved: () => void;
}

function SkillModal({ skill, onClose, onSaved }: SkillModalProps) {
  const isNew = !skill;
  const [id, setId] = useState(skill?.id || '');
  const [name, setName] = useState(skill?.name || '');
  const [nameEn, setNameEn] = useState(skill?.name_en || '');
  const [description, setDescription] = useState(skill?.description || '');
  const [promptSnippet, setPromptSnippet] = useState(skill?.prompt_snippet || '');
  const [tools, setTools] = useState((skill?.tools || []).join(', '));
  const [mcpServersJson, setMcpServersJson] = useState(
    skill?.mcp_servers && skill.mcp_servers.length > 0
      ? JSON.stringify(skill.mcp_servers, null, 2)
      : ''
  );
  const [mcpJsonError, setMcpJsonError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Название обязательно'); return; }
    setSubmitting(true); setError(null); setMcpJsonError(null);
    const toolsList = tools.split(',').map(t => t.trim()).filter(Boolean);
    let mcpServers: McpServerDef[] | undefined;
    if (mcpServersJson.trim()) {
      try {
        const parsed = JSON.parse(mcpServersJson);
        mcpServers = Array.isArray(parsed) ? parsed : undefined;
        if (!mcpServers) { setMcpJsonError('Должен быть массив объектов []'); setSubmitting(false); return; }
      } catch {
        setMcpJsonError('Невалидный JSON'); setSubmitting(false); return;
      }
    }
    try {
      if (isNew) {
        await api.skills.create({
          id: id.trim() || undefined,
          name: name.trim(),
          name_en: nameEn.trim() || undefined,
          description: description.trim() || undefined,
          prompt_snippet: promptSnippet.trim() || undefined,
          tools: toolsList.length > 0 ? toolsList : undefined,
          mcp_servers: mcpServers,
        });
      } else {
        await api.skills.update(skill!.id, {
          name: name.trim(),
          name_en: nameEn.trim() || undefined,
          description: description.trim() || undefined,
          prompt_snippet: promptSnippet.trim() || undefined,
          tools: toolsList.length > 0 ? toolsList : undefined,
          mcp_servers: mcpServers,
        });
      }
      onSaved(); onClose();
    } catch (err: any) { setError(err.message); setSubmitting(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>{isNew ? 'Новый навык' : `Редактировать: ${skill!.name}`}</h2>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={submit}>
          {isNew && (
            <div className="form-group">
              <label>ID (необязательно)</label>
              <input value={id} onChange={e => setId(e.target.value)} placeholder="auto-generated from name" />
              <span className="form-hint">Уникальный идентификатор. Если не задан — генерируется из названия</span>
            </div>
          )}
          {!isNew && (
            <div className="form-group">
              <label>ID</label>
              <input value={skill!.id} disabled style={{ background: '#f8fafc', color: '#94a3b8' }} />
            </div>
          )}
          <div className="form-group">
            <label>Название *</label>
            <input value={name} onChange={e => setName(e.target.value)} autoFocus required placeholder="Например: Анализ данных" />
          </div>
          <div className="form-group">
            <label>Название (EN)</label>
            <input value={nameEn} onChange={e => setNameEn(e.target.value)} placeholder="Data Analysis" />
          </div>
          <div className="form-group">
            <label>Описание</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              placeholder="Краткое описание навыка"
            />
          </div>
          <div className="form-group">
            <label>Инструкция</label>
            <textarea
              value={promptSnippet}
              onChange={e => setPromptSnippet(e.target.value)}
              rows={5}
              style={{ fontFamily: 'monospace', fontSize: 13 }}
              placeholder="Текст, который будет добавлен в CLAUDE.md агентов с этим навыком"
            />
            <span className="form-hint">Инжектируется в системный промпт агента при старте</span>
          </div>
          <div className="form-group">
            <label>Инструменты (через запятую)</label>
            <input value={tools} onChange={e => setTools(e.target.value)} placeholder="bash, read, write" />
            <span className="form-hint">Список MCP-инструментов, используемых в этом навыке</span>
          </div>
          <div className="form-group">
            <label>MCP Servers (JSON)</label>
            <textarea
              value={mcpServersJson}
              onChange={e => { setMcpServersJson(e.target.value); setMcpJsonError(null); }}
              rows={5}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
              placeholder={'[\n  {\n    "name": "my-server",\n    "command": "node",\n    "args": ["/path/to/server.js"],\n    "env": {"KEY": "${VAR}"}\n  }\n]'}
            />
            {mcpJsonError && <span className="mcp-json-error">{mcpJsonError}</span>}
            <span className="form-hint">Массив MCP-серверов для агентов с этим навыком. Поддерживается {"${VAR}"} из env агента или /opt/konoha/.env.global</span>
          </div>
          <div className="form-actions">
            <button type="button" className="btn-cancel-f" onClick={onClose}>Отмена</button>
            <button type="submit" className="btn-submit" disabled={submitting}>
              {submitting ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function Skills() {
  const token = useToken();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editSkill, setEditSkill] = useState<Skill | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(() => {
    if (!token) return;
    api.skills.list()
      .then(data => { setSkills(data); setError(null); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  useEffect(() => { load(); }, [load]);

  function openEdit(s: Skill) { setEditSkill(s); setShowModal(true); }
  function openNew() { setEditSkill(null); setShowModal(true); }

  async function deleteSkill(e: React.MouseEvent, s: Skill) {
    e.stopPropagation();
    if (!confirm(`Удалить навык "${s.name}"?`)) return;
    try {
      await api.skills.delete(s.id);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <Layout activePage="skills.html">
      <style>{styles}</style>
      <div className="skills-body">
        <div className="container">
          <div className="page-header">
            <h1>Навыки</h1>
            <input
              className="search-input"
              placeholder="Поиск навыков…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <button className="btn-new" onClick={openNew}>+ Добавить навык</button>
          </div>
          {error && <div className="error-banner">{error}</div>}
          {loading && <div className="empty">Загрузка…</div>}
          {!loading && skills.length === 0 && (
            <div className="empty">Навыки не созданы. Нажмите «+ Добавить навык».</div>
          )}
          {!loading && skills.length > 0 && (
            <table className="table" style={{ tableLayout: 'fixed', width: '100%' }}>
              <colgroup>
                <col style={{ width: '120px' }} />
                <col style={{ width: '150px' }} />
                <col style={{ width: '180px' }} />
                <col style={{ width: 'auto' }} />
                <col style={{ width: '120px' }} />
                <col style={{ width: '80px' }} />
                <col style={{ width: '70px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Название</th>
                  <th>Описание</th>
                  <th>Инструкция</th>
                  <th>Инструменты</th>
                  <th>MCP</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {skills.filter(s => {
                  if (!search.trim()) return true;
                  const q = search.toLowerCase();
                  return s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q);
                }).map(s => (
                  <tr key={s.id} className="row-clickable" onClick={() => openEdit(s)}>
                    <td><span className="skill-id">{s.id}</span></td>
                    <td style={{ fontWeight: 600 }}>
                      {s.name}
                      {s.name_en && <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 400 }}>{s.name_en}</div>}
                    </td>
                    <td><span className="skill-desc">{s.description || '—'}</span></td>
                    <td>
                      {s.prompt_snippet
                        ? <span className="snippet-preview">{s.prompt_snippet}</span>
                        : <span style={{ color: '#94a3b8', fontSize: 12 }}>—</span>}
                    </td>
                    <td style={{ overflow: 'hidden' }}>
                      {(s.tools || []).length === 0 && <span style={{ color: '#94a3b8', fontSize: 12 }}>—</span>}
                      {(s.tools || []).slice(0, 2).map(t => <span key={t} className="tag">{t}</span>)}
                      {(s.tools || []).length > 2 && (
                        <span className="tag" style={{ background: '#f1f5f9', color: '#64748b' }}>+{s.tools!.length - 2}</span>
                      )}
                    </td>
                    <td>
                      {s.mcp_servers && s.mcp_servers.length > 0
                        ? <span className="mcp-badge">⚙ {s.mcp_servers.length}</span>
                        : <span style={{ color: '#94a3b8', fontSize: 12 }}>—</span>}
                    </td>
                    <td style={{ width: 70, textAlign: 'right' }}>
                      <button className="btn-delete" onClick={e => deleteSkill(e, s)}>Удалить</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {showModal && (
        <SkillModal
          skill={editSkill}
          onClose={() => setShowModal(false)}
          onSaved={load}
        />
      )}
    </Layout>
  );
}
