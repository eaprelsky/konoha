import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type React from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { RoleDef, AssignmentStrategy, Agent, Person } from '../api/types';
import { KibaPanel, KIBA_CSS } from '../components/KibaPanel';

const STRATEGIES: { value: AssignmentStrategy; label: string }[] = [
  { value: 'manual',          label: 'Вручную' },
  { value: 'round-robin',     label: 'По кругу' },
  { value: 'load-balancing',  label: 'Баланс нагрузки' },
  { value: 'broadcast',       label: 'Широковещательно' },
];

const STRATEGY_LABELS: Record<AssignmentStrategy, string> = {
  manual:           'Вручную',
  'round-robin':    'По кругу',
  'load-balancing': 'Баланс нагрузки',
  broadcast:        'Широковещательно',
};

const styles = `
  .rl-body { padding: 20px; }
  .container { max-width: 1060px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .page-header h1 { color: #333; font-size: 24px; }
  .btn-new { padding: 8px 18px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; }
  .btn-new:hover { background: #0052a3; }
  .table { width: 100%; border-collapse: collapse; }
  .table th { background: #f9f9f9; padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #666; border-bottom: 2px solid #eee; text-transform: uppercase; }
  .table td { padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; vertical-align: middle; }
  .table tr:hover td { background: #fafafa; }
  .tag { display: inline-block; padding: 2px 8px; background: #eff6ff; color: #1d4ed8; border-radius: 10px; font-size: 11px; margin: 1px; }
  .strategy-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; background: #f0fdf4; color: #15803d; }
  .actions { display: flex; gap: 6px; }
  .actions button { padding: 5px 10px; border: 1px solid #ddd; background: white; border-radius: 3px; cursor: pointer; font-size: 12px; }
  .actions .edit { background: #3b82f6; color: white; border-color: #3b82f6; }
  .actions .del { background: #ef4444; color: white; border-color: #ef4444; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }
  .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.5); z-index: 1000; display: flex; justify-content: center; align-items: center; }
  .modal { background: white; border-radius: 8px; padding: 32px; width: 500px; max-width: 95vw; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 25px rgba(0,0,0,.15); }
  .modal h2 { margin-bottom: 18px; color: #333; }
  .form-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
  .form-group label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; }
  .form-group input, .form-group select { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .form-group input:focus, .form-group select:focus { outline: none; border-color: #0066cc; }
  .form-group .hint { font-size: 11px; color: #888; }
  .desc-toggle { font-size: 12px; color: #0066cc; cursor: pointer; background: none; border: none; padding: 0; margin-top: 4px; margin-bottom: 8px; text-decoration: underline; }
  .form-group textarea { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; font-family: inherit; resize: vertical; min-height: 64px; }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .form-actions button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .btn-submit { background: #0066cc; color: white; }
  .btn-cancel-f { background: #e5e7eb; color: #374151; }
  /* Multiselect assignees */
  .ms-wrapper { position: relative; }
  .ms-trigger { display: flex; flex-wrap: wrap; gap: 4px; min-height: 38px; padding: 5px 8px; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; background: white; align-items: center; }
  .ms-trigger:hover { border-color: #0066cc; }
  .ms-tag { display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px; background: #eff6ff; color: #1d4ed8; border-radius: 10px; font-size: 12px; }
  .ms-tag-del { background: none; border: none; cursor: pointer; color: #64748b; font-size: 12px; padding: 0; line-height: 1; }
  .ms-placeholder { color: #9ca3af; font-size: 13px; }
  .ms-dropdown { background: white; border: 1px solid #ddd; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,.12); z-index: 9999; max-height: 220px; overflow-y: auto; }
  .ms-search { width: 100%; padding: 7px 10px; border: none; border-bottom: 1px solid #eee; font-size: 13px; outline: none; box-sizing: border-box; }
  .ms-group-label { padding: 6px 10px 2px; font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; }
  .ms-option { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer; font-size: 13px; }
  .ms-option:hover { background: #f1f5f9; }
  .ms-option.selected { background: #eff6ff; }
  .ms-option input[type=checkbox] { accent-color: #0066cc; flex-shrink: 0; }
  .ms-empty { padding: 10px; color: #999; font-size: 13px; text-align: center; }
`;

// ── Multiselect component ─────────────────────────────────────────────────────
interface AssigneeOption { id: string; label: string; group: string }
interface MultiselectProps {
  options: AssigneeOption[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}

function Multiselect({ options, value, onChange, placeholder = 'Выберите…' }: MultiselectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, width: 0 });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  function handleTriggerClick() {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setDropPos({ top: rect.bottom + 2, left: rect.left, width: rect.width });
    }
    setOpen(o => !o);
  }

  const filtered = options.filter(o =>
    o.label.toLowerCase().includes(search.toLowerCase()) ||
    o.id.toLowerCase().includes(search.toLowerCase())
  );

  const groups = ['Агенты', 'Люди'];
  const grouped = groups.map(g => ({ group: g, items: filtered.filter(o => o.group === g) }));

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter(v => v !== id) : [...value, id]);
  }

  const dropdown = (
    <div
      className="ms-dropdown"
      style={{ position: 'fixed', top: dropPos.top, left: dropPos.left, width: dropPos.width }}
    >
      <input
        className="ms-search"
        placeholder="Поиск…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        onClick={e => e.stopPropagation()}
        autoFocus
      />
      {grouped.every(g => g.items.length === 0) && (
        <div className="ms-empty">Ничего не найдено</div>
      )}
      {grouped.map(({ group, items }) => items.length === 0 ? null : (
        <div key={group}>
          <div className="ms-group-label">{group}</div>
          {items.map(opt => (
            <div
              key={opt.id}
              className={`ms-option${value.includes(opt.id) ? ' selected' : ''}`}
              onClick={() => toggle(opt.id)}
            >
              <input type="checkbox" checked={value.includes(opt.id)} readOnly />
              <span>{opt.label}</span>
              <span style={{ color: '#94a3b8', fontSize: 11, marginLeft: 'auto' }}>{opt.id}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <div className="ms-wrapper" ref={ref}>
      <div className="ms-trigger" onClick={handleTriggerClick}>
        {value.length === 0 && <span className="ms-placeholder">{placeholder}</span>}
        {value.map(v => {
          const opt = options.find(o => o.id === v);
          return (
            <span key={v} className="ms-tag">
              {opt?.label || v}
              <button
                className="ms-tag-del"
                onClick={e => { e.stopPropagation(); toggle(v); }}
                type="button"
              >×</button>
            </span>
          );
        })}
      </div>
      {open && createPortal(dropdown, document.body)}
    </div>
  );
}

// ── Role modal ────────────────────────────────────────────────────────────────
interface RoleModalProps {
  role?: RoleDef | null;
  agents: Agent[];
  people: Person[];
  onClose: () => void;
  onSaved: () => void;
}

function RoleModal({ role, agents, people, onClose, onSaved }: RoleModalProps) {
  const [name, setName] = useState(role?.name || '');
  const [description, setDescription] = useState(role?.description || '');
  const [showDesc, setShowDesc] = useState(!!role?.description);
  const [assignees, setAssignees] = useState<string[]>(role?.assignees || []);
  const [strategy, setStrategy] = useState<AssignmentStrategy>(role?.strategy || 'manual');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const assigneeOptions: AssigneeOption[] = [
    ...agents.map(a => ({ id: a.id, label: a.name, group: 'Агенты' })),
    ...people.map(p => ({ id: p.id, label: `${p.name}${p.position ? ` (${p.position})` : ''}`, group: 'Люди' })),
  ];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Название обязательно'); return; }
    setSubmitting(true); setError(null);
    try {
      if (role) {
        await api.roles.update(role.role_id, { name, description: description || undefined, assignees, strategy });
      } else {
        const role_id = crypto.randomUUID();
        await api.roles.create({ role_id, name, description: description || undefined, assignees, strategy });
      }
      onSaved(); onClose();
    } catch (err: any) { setError(err.message); setSubmitting(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>{role ? 'Редактировать роль' : 'Новая роль'}</h2>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={submit}>

          <div className="form-group">
            <label>Название *</label>
            <input
              type="text"
              placeholder="Например: Менеджер по продажам"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
              required
            />
          </div>

          <button
            type="button"
            className="desc-toggle"
            onClick={() => setShowDesc(v => !v)}
          >
            {showDesc ? '▲ Скрыть описание' : '▼ Добавить описание'}
          </button>

          {showDesc && (
            <div className="form-group">
              <label>Описание</label>
              <textarea
                placeholder="Опционально…"
                value={description}
                onChange={e => setDescription(e.target.value)}
              />
            </div>
          )}

          <div className="form-group">
            <label>Исполнители</label>
            <Multiselect
              options={assigneeOptions}
              value={assignees}
              onChange={setAssignees}
              placeholder="Выберите агентов или людей…"
            />
          </div>

          <div className="form-group">
            <label>Стратегия назначения</label>
            <select value={strategy} onChange={e => setStrategy(e.target.value as AssignmentStrategy)}>
              {STRATEGIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
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

// ── Main page ─────────────────────────────────────────────────────────────────
export function Roles() {
  const token = useToken();
  const [roles,   setRoles]   = useState<RoleDef[]>([]);
  const [agents,  setAgents]  = useState<Agent[]>([]);
  const [people,  setPeople]  = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editRole,  setEditRole]  = useState<RoleDef | null>(null);
  const [showKiba,  setShowKiba]  = useState(false);

  const load = useCallback(() => {
    if (!token) return;
    api.roles.list()
      .then(data => { setRoles(data); setError(null); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 30000);

  useEffect(() => {
    if (!token) return;
    api.agents.list().then(setAgents).catch(() => {});
    api.people.list().then(setPeople).catch(() => {});
  }, [token]);

  async function deleteRole(id: string) {
    if (!confirm(`Удалить роль "${id}"?`)) return;
    try { await api.roles.delete(id); load(); } catch (e: any) { setError(e.message); }
  }

  function openEdit(r: RoleDef) { setEditRole(r); setShowModal(true); }
  function openNew()             { setEditRole(null); setShowModal(true); }

  return (
    <Layout activePage="roles.html">
      <style>{styles + KIBA_CSS}</style>
      <div style={{ display: 'flex', height: 'calc(100vh - 64px)' }}>
      <div className="rl-body" style={{ flex: 1, overflowY: 'auto' }}>
        <div className="container">
          <div className="page-header">
            <h1>Роли</h1>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-new" onClick={openNew}>+ Новая роль</button>
              <button style={{ padding: '8px 14px', background: showKiba ? '#004499' : '#1e293b', color: 'white', border: '1px solid #0066cc', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600 }} onClick={() => setShowKiba(v => !v)}>🐕 Киба</button>
            </div>
          </div>
          {error && <div className="error-banner">{error}</div>}
          {loading && <div className="empty">Загрузка…</div>}
          {!loading && roles.length === 0 && <div className="empty">Роли ещё не определены.</div>}
          {roles.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Стратегия</th>
                  <th>Исполнители</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {roles.map(r => (
                  <tr key={r.role_id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{r.name}</div>
                      <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}>{r.role_id}</div>
                      {r.description && (
                        <div style={{ color: '#666', fontSize: 12, marginTop: 2 }}>{r.description}</div>
                      )}
                    </td>
                    <td><span className="strategy-badge">{STRATEGY_LABELS[r.strategy] ?? r.strategy}</span></td>
                    <td>
                      {r.assignees.map(a => <span key={a} className="tag">{a}</span>)}
                      {r.assignees.length === 0 && <span style={{ color: '#999' }}>—</span>}
                    </td>
                    <td>
                      <div className="actions">
                        <button className="edit" onClick={() => openEdit(r)}>Изменить</button>
                        <button className="del"  onClick={() => deleteRole(r.role_id)}>Удалить</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {showKiba && (
        <KibaPanel
          page="roles"
          contextData={roles}
          onClose={() => setShowKiba(false)}
          onActionDone={load}
        />
      )}
      </div>
      {showModal && (
        <RoleModal
          role={editRole}
          agents={agents}
          people={people}
          onClose={() => setShowModal(false)}
          onSaved={load}
        />
      )}
    </Layout>
  );
}
