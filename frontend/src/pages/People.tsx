import { useState, useCallback, useEffect, useRef } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { Person } from '../api/types';

const styles = `
  .ppl-body { padding: 20px; }
  .container { max-width: 900px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 12px; }
  .page-header h1 { color: #333; font-size: 24px; }
  .header-right { display: flex; gap: 8px; align-items: center; }
  .search-input { padding: 7px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; width: 220px; }
  .search-input:focus { outline: none; border-color: #0066cc; }
  .btn-new { padding: 7px 16px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; white-space: nowrap; }
  .btn-new:hover { background: #0052a3; }
  .table { width: 100%; border-collapse: collapse; }
  .table th { background: #f9f9f9; padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #666; border-bottom: 2px solid #eee; text-transform: uppercase; }
  .table td { padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; vertical-align: middle; }
  .table tr:hover td { background: #fafafa; cursor: pointer; }
  .tg-link { color: #0066cc; text-decoration: none; font-family: monospace; font-size: 13px; }
  .tg-link:hover { text-decoration: underline; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }
  .position { color: #64748b; font-size: 13px; }
  .custom-badge { display: inline-block; padding: 1px 6px; background: #eff6ff; color: #1d4ed8; border-radius: 8px; font-size: 10px; margin-left: 6px; vertical-align: middle; }
  /* Modal */
  .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.5); z-index: 1000; display: flex; justify-content: center; align-items: center; }
  .modal { background: white; border-radius: 8px; padding: 32px; width: 460px; max-width: 95vw; box-shadow: 0 20px 25px rgba(0,0,0,.15); }
  .modal h2 { margin-bottom: 20px; color: #333; }
  .form-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
  .form-group label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; }
  .form-group input { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .form-group input:focus { outline: none; border-color: #0066cc; }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .form-actions button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .btn-submit { background: #0066cc; color: white; }
  .btn-cancel-f { background: #e5e7eb; color: #374151; }
`;

interface PersonModalProps {
  person?: Person | null;
  onClose: () => void;
  onSaved: () => void;
}

function PersonModal({ person, onClose, onSaved }: PersonModalProps) {
  const [name, setName] = useState(person?.name || '');
  const [position, setPosition] = useState(person?.position || '');
  const [tgUsername, setTgUsername] = useState(person?.tg_username || '');
  const [email, setEmail] = useState(person?.email || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Имя обязательно'); return; }
    setSubmitting(true); setError(null);
    try {
      await api.people.save({
        id: person?.id,
        name: name.trim(),
        position: position.trim(),
        tg_id: person?.tg_id ?? 0,
        tg_username: tgUsername.trim() || undefined,
        email: email.trim() || undefined,
      });
      onSaved(); onClose();
    } catch (err: any) { setError(err.message); setSubmitting(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>{person ? 'Редактировать' : 'Новый человек'}</h2>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={submit}>
          <div className="form-group">
            <label>Имя *</label>
            <input value={name} onChange={e => setName(e.target.value)} autoFocus required />
          </div>
          <div className="form-group">
            <label>Должность</label>
            <input value={position} onChange={e => setPosition(e.target.value)} placeholder="Например: Разработчик" />
          </div>
          <div className="form-group">
            <label>Telegram username</label>
            <input value={tgUsername} onChange={e => setTgUsername(e.target.value)} placeholder="username (без @)" />
          </div>
          <div className="form-group">
            <label>Email (опционально)</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="email@example.com" />
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

export function People() {
  const token = useToken();
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editPerson, setEditPerson] = useState<Person | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    api.people.list()
      .then(data => { setPeople(data); setError(null); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 60000);

  const q = search.toLowerCase();
  const filtered = people.filter(p =>
    p.name.toLowerCase().includes(q) ||
    (p.position || '').toLowerCase().includes(q) ||
    (p.tg_username || '').toLowerCase().includes(q) ||
    (p.email || '').toLowerCase().includes(q)
  );

  function openEdit(p: Person) { setEditPerson(p); setShowModal(true); }
  function openNew() { setEditPerson(null); setShowModal(true); }

  return (
    <Layout activePage="people.html">
      <style>{styles}</style>
      <div className="ppl-body">
        <div className="container">
          <div className="page-header">
            <h1>Люди</h1>
            <div className="header-right">
              <input
                className="search-input"
                placeholder="Поиск…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <button className="btn-new" onClick={openNew}>+ Добавить</button>
            </div>
          </div>
          {error && <div className="error-banner">{error}</div>}
          {loading && <div className="empty">Загрузка…</div>}
          {!loading && filtered.length === 0 && <div className="empty">Ничего не найдено.</div>}
          {!loading && filtered.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Имя</th>
                  <th>Должность</th>
                  <th>Telegram</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => (
                  <tr key={p.id} onClick={() => openEdit(p)}>
                    <td style={{ fontWeight: 600 }}>
                      {p.name}
                      {p.email && <span className="custom-badge">custom</span>}
                    </td>
                    <td><span className="position">{p.position || '—'}</span></td>
                    <td>
                      {p.tg_username ? (
                        <a
                          className="tg-link"
                          href={`https://t.me/${p.tg_username}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={e => e.stopPropagation()}
                        >
                          @{p.tg_username}
                        </a>
                      ) : p.tg_id ? (
                        <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#94a3b8' }}>
                          id:{p.tg_id}
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{ color: '#64748b', fontSize: 13 }}>{p.email || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {showModal && (
        <PersonModal
          person={editPerson}
          onClose={() => setShowModal(false)}
          onSaved={load}
        />
      )}
    </Layout>
  );
}
