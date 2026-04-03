import { useState, useCallback, useEffect } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { Person, Skill } from '../api/types';
import { KibaPanel, KIBA_CSS } from '../components/KibaPanel';

const styles = `
  .ppl-body { padding: 20px; }
  .container { max-width: 960px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
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
  .table tr:hover td { background: #fafafa; }
  .row-clickable { cursor: pointer; }
  .tg-link { color: #0066cc; text-decoration: none; font-family: monospace; font-size: 13px; }
  .tg-link:hover { text-decoration: underline; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }
  .position { color: #64748b; font-size: 13px; }
  .badge-custom { display: inline-block; padding: 1px 6px; background: #eff6ff; color: #1d4ed8; border-radius: 8px; font-size: 10px; margin-left: 6px; vertical-align: middle; }
  .badge-file { display: inline-block; padding: 1px 6px; background: #f0fdf4; color: #166534; border-radius: 8px; font-size: 10px; margin-left: 6px; vertical-align: middle; }
  .btn-delete { padding: 3px 8px; background: transparent; color: #dc2626; border: 1px solid #fca5a5; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .btn-delete:hover { background: #fee2e2; }
  /* Modal */
  .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.5); z-index: 1000; display: flex; justify-content: center; align-items: center; }
  .modal { background: white; border-radius: 8px; padding: 32px; width: 500px; max-width: 95vw; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 25px rgba(0,0,0,.15); }
  .modal h2 { margin-bottom: 20px; color: #333; }
  .form-section { font-size: 11px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; margin: 18px 0 10px; padding-bottom: 4px; border-bottom: 1px solid #f1f5f9; }
  .form-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
  .form-group label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; }
  .form-group input { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .form-group input:focus { outline: none; border-color: #0066cc; }
  .form-group input:disabled { background: #f8fafc; color: #94a3b8; cursor: not-allowed; }
  .form-hint { font-size: 11px; color: #94a3b8; margin-top: 2px; }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .form-actions button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .btn-submit { background: #0066cc; color: white; }
  .btn-cancel-f { background: #e5e7eb; color: #374151; }
`;

interface PersonModalProps {
  person?: Person | null;
  skills: Skill[];
  onClose: () => void;
  onSaved: () => void;
}

function PersonModal({ person, skills, onClose, onSaved }: PersonModalProps) {
  const isFile = person?.source === 'file';
  const isNew = !person;

  const [name, setName] = useState(person?.name || '');
  const [position, setPosition] = useState(person?.position || '');
  const [tgId, setTgId] = useState(person?.tg_id ? String(person.tg_id) : '');
  const [tgUsername, setTgUsername] = useState(person?.tg_username || '');
  const [email, setEmail] = useState(person?.email || '');
  const [bitrix24Id, setBitrix24Id] = useState(person?.bitrix24_id || '');
  const [trackerLogin, setTrackerLogin] = useState(person?.tracker_login || '');
  const [yonoteId, setYonoteId] = useState(person?.yonote_id || '');
  const [channel, setChannel] = useState<'telegram' | 'email'>(person?.channel || 'telegram');
  const [capabilities, setCapabilities] = useState<string[]>(person?.capabilities || []);
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(person?.avatar_url);
  const [avatarStyle, setAvatarStyle] = useState('professional photo');
  const [generatingAvatar, setGeneratingAvatar] = useState(false);
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
        tg_id: tgId ? parseInt(tgId, 10) : (person?.tg_id ?? 0),
        tg_username: tgUsername.trim() || undefined,
        email: email.trim() || undefined,
        bitrix24_id: bitrix24Id.trim() || undefined,
        tracker_login: trackerLogin.trim() || undefined,
        yonote_id: yonoteId.trim() || undefined,
        channel,
        capabilities: capabilities.length > 0 ? capabilities : undefined,
        avatar_url: avatarUrl,
      });
      onSaved(); onClose();
    } catch (err: any) { setError(err.message); setSubmitting(false); }
  }

  async function doGenerateAvatar() {
    if (!person?.id) { setError('Сначала сохраните пользователя'); return; }
    setGeneratingAvatar(true);
    try {
      const res = await api.people.generateAvatar(person.id, { style: avatarStyle, description: position || undefined });
      setAvatarUrl(res.avatar_url);
    } catch (e: any) {
      setError(`Аватар: ${e.message}`);
    } finally {
      setGeneratingAvatar(false);
    }
  }

  const title = isNew ? 'Новый пользователь' : isFile ? person!.name : 'Редактировать';

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>{title}</h2>
        {isFile && (
          <div style={{ background: '#f0fdf4', color: '#166534', padding: '8px 12px', borderRadius: 4, fontSize: 13, marginBottom: 16 }}>
            Пользователь из файла (trusted-users.json). Интеграционные поля доступны для редактирования.
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={submit}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
            <div style={{ flexShrink: 0 }}>
              {avatarUrl
                ? <img src={avatarUrl} alt="avatar" style={{ width: 64, height: 64, borderRadius: 50, objectFit: 'cover', border: '2px solid #e2e8f0' }} />
                : <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#0066cc', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, color: 'white', fontWeight: 700, border: '2px solid #e2e8f0', userSelect: 'none' }}>
                    {name.charAt(0).toUpperCase() || '?'}
                  </div>
              }
            </div>
            {!isNew && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Аватар</div>
                <input
                  type="text"
                  value={avatarStyle}
                  onChange={e => setAvatarStyle(e.target.value)}
                  placeholder="professional photo, anime, pixel art…"
                  style={{ padding: '5px 10px', border: '1px solid #ddd', borderRadius: 4, fontSize: 13 }}
                />
                <button type="button" onClick={doGenerateAvatar} disabled={generatingAvatar}
                  style={{ padding: '5px 12px', background: '#0066cc', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: generatingAvatar ? 0.6 : 1 }}>
                  {generatingAvatar ? '⏳ Генерируется…' : '✨ Сгенерировать аватар'}
                </button>
              </div>
            )}
          </div>
          <div className="form-section">Основное</div>
          <div className="form-group">
            <label>Имя *</label>
            <input value={name} onChange={e => setName(e.target.value)} autoFocus required disabled={isFile} />
          </div>
          <div className="form-group">
            <label>Должность</label>
            <input value={position} onChange={e => setPosition(e.target.value)} placeholder="Например: Разработчик" disabled={isFile} />
          </div>
          <div className="form-group">
            <label>Telegram ID</label>
            <input
              value={tgId}
              onChange={e => setTgId(e.target.value)}
              placeholder="Числовой ID"
              type="number"
              disabled={isFile}
            />
          </div>
          <div className="form-group">
            <label>Telegram username</label>
            <input value={tgUsername} onChange={e => setTgUsername(e.target.value)} placeholder="username (без @)" disabled={isFile} />
          </div>
          <div className="form-group">
            <label>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="email@example.com" disabled={isFile} />
          </div>

          <div className="form-section">Уведомления</div>
          <div className="form-group">
            <label>Предпочтительный канал</label>
            <select value={channel} onChange={e => setChannel(e.target.value as 'telegram' | 'email')} style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 4, fontSize: 14, fontFamily: 'inherit' }}>
              <option value="telegram">Telegram (по умолчанию)</option>
              <option value="email">Email</option>
            </select>
            <span className="form-hint">Используется при диспетчеризации задач пользователю</span>
          </div>

          <div className="form-section">Интеграции</div>
          <div className="form-group">
            <label>Bitrix24 User ID</label>
            <input value={bitrix24Id} onChange={e => setBitrix24Id(e.target.value)} placeholder="Числовой ID в Bitrix24" />
            <span className="form-hint">Используется адаптером Bitrix24 для маппинга</span>
          </div>
          <div className="form-group">
            <label>Yandex Tracker Login</label>
            <input value={trackerLogin} onChange={e => setTrackerLogin(e.target.value)} placeholder="login" />
            <span className="form-hint">Логин в Яндекс Трекере</span>
          </div>
          <div className="form-group">
            <label>Yonote User ID</label>
            <input value={yonoteId} onChange={e => setYonoteId(e.target.value)} placeholder="UUID или логин" />
            <span className="form-hint">ID пользователя в Yonote</span>
          </div>

          {skills.length > 0 && (
            <>
              <div className="form-section">Навыки</div>
              <div className="form-group">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 0' }}>
                  {skills.map(s => (
                    <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 10px', border: `1px solid ${capabilities.includes(s.id) ? '#6366f1' : '#ddd'}`, borderRadius: 16, cursor: 'pointer', fontSize: 13, background: capabilities.includes(s.id) ? '#ede9fe' : 'white', color: capabilities.includes(s.id) ? '#4f46e5' : '#374151', userSelect: 'none' }}>
                      <input type="checkbox" checked={capabilities.includes(s.id)} onChange={() => setCapabilities(prev => prev.includes(s.id) ? prev.filter(c => c !== s.id) : [...prev, s.id])} style={{ display: 'none' }} />
                      {capabilities.includes(s.id) ? '✓ ' : ''}{s.name}
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

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
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editPerson, setEditPerson] = useState<Person | null>(null);
  const [showKiba, setShowKiba] = useState(false);

  const load = useCallback(() => {
    if (!token) return;
    api.people.list()
      .then(data => { setPeople(data); setError(null); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 60000);

  useEffect(() => {
    if (!token) return;
    api.skills.list().then(setSkills).catch(() => {});
  }, [token]);

  const q = search.toLowerCase();
  const filtered = people.filter(p =>
    p.name.toLowerCase().includes(q) ||
    (p.position || '').toLowerCase().includes(q) ||
    (p.tg_username || '').toLowerCase().includes(q) ||
    (p.email || '').toLowerCase().includes(q)
  );

  function openEdit(p: Person) { setEditPerson(p); setShowModal(true); }
  function openNew() { setEditPerson(null); setShowModal(true); }

  async function deletePerson(e: React.MouseEvent, p: Person) {
    e.stopPropagation();
    if (!confirm(`Удалить пользователя "${p.name}"?`)) return;
    try {
      await api.people.delete(p.id);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <Layout activePage="people.html">
      <style>{styles + KIBA_CSS}</style>
      <div style={{ display: 'flex', height: 'calc(100vh - 105px)' }}>
      <div className="ppl-body" style={{ flex: 1, overflowY: 'auto' }}>
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
              <button style={{ padding: '7px 14px', background: showKiba ? '#004499' : '#1e293b', color: 'white', border: '1px solid #0066cc', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600 }} onClick={() => setShowKiba(v => !v)}>🐕 Киба</button>
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
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => (
                  <tr key={p.id} className="row-clickable" onClick={() => openEdit(p)}>
                    <td style={{ fontWeight: 600 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {p.avatar_url
                          ? <img src={p.avatar_url} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                          : <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#0066cc', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'white', fontWeight: 700, flexShrink: 0 }}>{p.name.charAt(0).toUpperCase()}</div>
                        }
                        <span>
                          {p.name}
                          {p.source === 'custom' && <span className="badge-custom">custom</span>}
                          {p.source === 'file' && <span className="badge-file">trusted</span>}
                        </span>
                      </div>
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
                    <td style={{ width: 60, textAlign: 'right' }}>
                      {p.source === 'custom' && (
                        <button
                          className="btn-delete"
                          onClick={e => deletePerson(e, p)}
                          title="Удалить"
                        >
                          Удалить
                        </button>
                      )}
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
          page="people"
          contextData={people}
          onClose={() => setShowKiba(false)}
          onActionDone={load}
        />
      )}
      </div>
      {showModal && (
        <PersonModal
          person={editPerson}
          skills={skills}
          onClose={() => setShowModal(false)}
          onSaved={load}
        />
      )}
    </Layout>
  );
}
