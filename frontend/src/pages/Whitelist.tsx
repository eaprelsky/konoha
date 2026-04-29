import { useState, useCallback, useEffect } from 'react';
import type React from 'react';
import { api } from '../api/client';

interface TrustedUserEntry {
  type: 'user';
  name: string;
  telegram_id: number;
  username: string | null;
  position: string | null;
  level: number;
  status: 'approved';
}

interface GroupEntry {
  type: 'group';
  chat_id: number;
  name: string | null;
  status: 'approved';
}

interface PendingEntry {
  type: 'user' | 'group';
  name?: string;
  telegram_id?: number;
  chat_id?: number;
  username?: string | null;
  last_seen?: string;
  source?: 'direct' | 'group';
  member_count?: number;
  status: 'pending';
}

interface WhitelistData {
  owner: { name: string; telegram_id: number; username: string } | null;
  trusted: TrustedUserEntry[];
  whitelisted_groups: GroupEntry[];
  pending: PendingEntry[];
}

const styles = `
  .wl-body { padding: 20px; }
  .container { max-width: 1100px; margin: 0 auto; }
  h1 { color: #1e293b; font-size: 22px; margin-bottom: 4px; }
  .subtitle { color: #64748b; font-size: 13px; margin-bottom: 24px; }
  .section-title { font-size: 16px; font-weight: 700; color: #1e293b; margin: 24px 0 12px; display: flex; align-items: center; gap: 8px; }
  .badge { display: inline-block; background: #e2e8f0; color: #475569; font-size: 11px; font-weight: 600; border-radius: 10px; padding: 2px 8px; }
  .badge-pending { background: #fef3c7; color: #92400e; }
  .table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); font-size: 13px; }
  .table th { background: #f8fafc; color: #64748b; font-weight: 600; text-align: left; padding: 10px 14px; border-bottom: 1px solid #e2e8f0; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .table td { padding: 10px 14px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
  .table tr:last-child td { border-bottom: none; }
  .table tr:hover td { background: #f8fafc; }
  .name { font-weight: 600; color: #1e293b; }
  .meta { font-size: 11px; color: #94a3b8; margin-top: 2px; }
  .level-1 { color: #7c3aed; font-weight: 600; }
  .level-2 { color: #1d4ed8; font-weight: 600; }
  .action-btn { padding: 4px 10px; border-radius: 4px; border: 1px solid; font-size: 12px; cursor: pointer; font-weight: 500; }
  .btn-approve { background: #ecfdf5; color: #065f46; border-color: #6ee7b7; }
  .btn-approve:hover { background: #d1fae5; }
  .btn-reject { background: #fff7ed; color: #9a3412; border-color: #fdba74; }
  .btn-reject:hover { background: #ffedd5; }
  .btn-delete { background: #fef2f2; color: #991b1b; border-color: #fca5a5; }
  .btn-delete:hover { background: #fee2e2; }
  .actions { display: flex; gap: 6px; }
  .empty { color: #94a3b8; font-size: 13px; padding: 16px; text-align: center; }
  .error-banner { background: #fee; color: #c33; padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; font-size: 13px; }
  .success-banner { background: #f0fdf4; color: #166534; padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #86efac; font-size: 13px; }
  .owner-card { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px 16px; display: flex; align-items: center; gap: 12px; margin-bottom: 20px; font-size: 13px; }
  .owner-label { color: #1d4ed8; font-weight: 700; font-size: 11px; text-transform: uppercase; }
  .owner-name { font-weight: 600; color: #1e293b; font-size: 14px; }
  .refresh-btn { padding: 5px 12px; border: 1px solid #e2e8f0; background: white; border-radius: 4px; font-size: 12px; cursor: pointer; color: #475569; }
  .refresh-btn:hover { background: #f8fafc; }
  .section-header { display: flex; justify-content: space-between; align-items: center; }
  .quick-form { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) auto; gap: 8px; align-items: end; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
  .quick-form.group { grid-template-columns: minmax(180px, 260px) auto; }
  .quick-field { display: flex; flex-direction: column; gap: 4px; }
  .quick-field label { font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; }
  .quick-field input { padding: 7px 10px; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 13px; }
  .btn-add { padding: 8px 14px; border-radius: 4px; border: 1px solid #93c5fd; background: #eff6ff; color: #1d4ed8; font-size: 12px; font-weight: 700; cursor: pointer; }
  .btn-add:hover { background: #dbeafe; }
`;

export function Whitelist() {
  const [data, setData] = useState<WhitelistData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [newUser, setNewUser] = useState({ name: '', telegram_id: '', username: '', position: '' });
  const [newGroup, setNewGroup] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.whitelist.get();
      setData(d);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function flash(msg: string) {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 3000);
  }

  function applyActionResult(result: { state?: WhitelistData } | undefined) {
    if (result?.state) setData(result.state);
    else void load();
  }

  async function approve(entry: PendingEntry) {
    try {
      if (entry.type === 'user' && entry.telegram_id) {
        const result = await api.whitelist.approve({ type: 'user', telegram_id: entry.telegram_id });
        applyActionResult(result);
        flash(`Пользователь ${entry.name ?? entry.telegram_id} одобрен`);
      } else if (entry.type === 'group' && entry.chat_id) {
        const result = await api.whitelist.approve({ type: 'group', chat_id: entry.chat_id });
        applyActionResult(result);
        flash(`Группа ${entry.chat_id} одобрена`);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function reject(entry: PendingEntry) {
    try {
      if (entry.type === 'user' && entry.telegram_id) {
        const result = await api.whitelist.reject({ type: 'user', telegram_id: entry.telegram_id });
        applyActionResult(result);
        flash(`Пользователь ${entry.name ?? entry.telegram_id} отклонён`);
      } else if (entry.type === 'group' && entry.chat_id) {
        const result = await api.whitelist.reject({ type: 'group', chat_id: entry.chat_id });
        applyActionResult(result);
        flash(`Группа ${entry.chat_id} отклонена`);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    const telegram_id = Number(newUser.telegram_id);
    if (!newUser.name.trim() || Number.isNaN(telegram_id)) {
      setError('Имя и числовой Telegram ID обязательны');
      return;
    }
    try {
      const result = await api.whitelist.upsertUser({
        name: newUser.name.trim(),
        telegram_id,
        username: newUser.username.trim().replace(/^@/, '') || undefined,
        position: newUser.position.trim() || undefined,
      });
      applyActionResult(result);
      setNewUser({ name: '', telegram_id: '', username: '', position: '' });
      flash('Доверенный пользователь сохранён');
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function addGroup(e: React.FormEvent) {
    e.preventDefault();
    const chat_id = Number(newGroup);
    if (Number.isNaN(chat_id)) {
      setError('Chat ID должен быть числом');
      return;
    }
    try {
      const result = await api.whitelist.addGroup({ chat_id });
      applyActionResult(result);
      setNewGroup('');
      flash('Группа добавлена');
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function deleteUser(telegram_id: number) {
    if (!confirm('Удалить пользователя из белого списка?')) return;
    try {
      const result = await api.whitelist.deleteUser(telegram_id);
      applyActionResult(result);
      flash('Пользователь удалён');
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function deleteGroup(chat_id: number) {
    if (!confirm('Удалить группу из белого списка?')) return;
    try {
      const result = await api.whitelist.deleteGroup(chat_id);
      applyActionResult(result);
      flash('Группа удалена');
    } catch (e: any) {
      setError(e.message);
    }
  }

  const pendingUsers = data?.pending.filter(p => p.type === 'user') ?? [];
  const pendingGroups = data?.pending.filter(p => p.type === 'group') ?? [];

  return (
    <>
      <style>{styles}</style>
      <div className="wl-body">
        <div className="container">
          <h1>Белый список</h1>
          <p className="subtitle">Управление доверенными пользователями и разрешёнными группами Telegram</p>

          {error && <div className="error-banner">{error}</div>}
          {success && <div className="success-banner">✓ {success}</div>}

          {data?.owner && (
            <div className="owner-card">
              <div>
                <div className="owner-label">Владелец</div>
                <div className="owner-name">{data.owner.name}</div>
                <div className="meta">@{data.owner.username} · ID: {data.owner.telegram_id}</div>
              </div>
            </div>
          )}

          <div className="section-title">Добавить доверенного пользователя</div>
          <form className="quick-form" onSubmit={addUser}>
            <div className="quick-field">
              <label>Имя *</label>
              <input value={newUser.name} onChange={e => setNewUser(v => ({ ...v, name: e.target.value }))} placeholder="Наташа Апрельская" />
            </div>
            <div className="quick-field">
              <label>Telegram ID *</label>
              <input value={newUser.telegram_id} onChange={e => setNewUser(v => ({ ...v, telegram_id: e.target.value }))} placeholder="123456789" />
            </div>
            <div className="quick-field">
              <label>Username</label>
              <input value={newUser.username} onChange={e => setNewUser(v => ({ ...v, username: e.target.value }))} placeholder="@username" />
            </div>
            <div className="quick-field">
              <label>Должность</label>
              <input value={newUser.position} onChange={e => setNewUser(v => ({ ...v, position: e.target.value }))} placeholder="Sales / PM / Founder" />
            </div>
            <button className="btn-add" type="submit">Добавить</button>
          </form>

          {/* Pending section */}
          {(pendingUsers.length > 0 || pendingGroups.length > 0) && (
            <>
              <div className="section-title">
                Ожидают решения
                <span className="badge badge-pending">{data!.pending.length}</span>
              </div>
              {pendingUsers.length > 0 && (
                <table className="table" style={{ marginBottom: 16 }}>
                  <thead>
                    <tr>
                      <th>Пользователь</th>
                      <th>ID</th>
                      <th>Последняя активность</th>
                      <th>Источник</th>
                      <th>Действия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingUsers.map(p => (
                      <tr key={`pu-${p.telegram_id}`}>
                        <td>
                          <div className="name">{p.name ?? '—'}</div>
                          {p.username && <div className="meta">@{p.username}</div>}
                        </td>
                        <td style={{ fontFamily: 'monospace', color: '#475569' }}>{p.telegram_id}</td>
                        <td style={{ color: '#64748b' }}>{p.last_seen ? new Date(p.last_seen).toLocaleString() : '—'}</td>
                        <td>{p.source === 'direct' ? 'Личное' : p.source === 'group' ? 'Группа' : '—'}</td>
                        <td>
                          <div className="actions">
                            <button className="action-btn btn-approve" onClick={() => approve(p)}>✓ Одобрить</button>
                            <button className="action-btn btn-reject" onClick={() => reject(p)}>✗ Отклонить</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {pendingGroups.length > 0 && (
                <table className="table" style={{ marginBottom: 16 }}>
                  <thead>
                    <tr>
                      <th>Группа</th>
                      <th>Chat ID</th>
                      <th>Участников</th>
                      <th>Последняя активность</th>
                      <th>Действия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingGroups.map(p => (
                      <tr key={`pg-${p.chat_id}`}>
                        <td><div className="name">{p.name ?? '—'}</div></td>
                        <td style={{ fontFamily: 'monospace', color: '#475569' }}>{p.chat_id}</td>
                        <td>{p.member_count ?? '—'}</td>
                        <td style={{ color: '#64748b' }}>{p.last_seen ? new Date(p.last_seen).toLocaleString() : '—'}</td>
                        <td>
                          <div className="actions">
                            <button className="action-btn btn-approve" onClick={() => approve(p)}>✓ Одобрить</button>
                            <button className="action-btn btn-reject" onClick={() => reject(p)}>✗ Отклонить</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {/* Trusted users */}
          <div className="section-header">
            <div className="section-title">
              Доверенные пользователи
              <span className="badge">{data?.trusted.length ?? 0}</span>
            </div>
            <button className="refresh-btn" onClick={load} disabled={loading}>↺ Обновить</button>
          </div>
          <table className="table" style={{ marginBottom: 16 }}>
            <thead>
              <tr>
                <th>Имя</th>
                <th>Username</th>
                <th>Telegram ID</th>
                <th>Должность</th>
                <th>Уровень</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {data?.trusted.length === 0 && (
                <tr><td colSpan={6}><div className="empty">Нет доверенных пользователей</div></td></tr>
              )}
              {data?.trusted.map(u => (
                <tr key={u.telegram_id}>
                  <td><div className="name">{u.name}</div></td>
                  <td style={{ color: '#475569' }}>{u.username ? `@${u.username}` : '—'}</td>
                  <td style={{ fontFamily: 'monospace', color: '#475569' }}>{u.telegram_id}</td>
                  <td style={{ color: '#64748b' }}>{u.position ?? '—'}</td>
                  <td>
                    <span className={`level-${u.level}`}>
                      {u.level === 1 ? 'Владелец' : u.level === 2 ? 'Доверенный' : `L${u.level}`}
                    </span>
                  </td>
                  <td>
                    <button className="action-btn btn-delete" onClick={() => deleteUser(u.telegram_id)}>
                      🗑 Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Whitelisted groups */}
          <div className="section-title">
            Разрешённые группы
            <span className="badge">{data?.whitelisted_groups.length ?? 0}</span>
          </div>
          <form className="quick-form group" onSubmit={addGroup}>
            <div className="quick-field">
              <label>Chat ID *</label>
              <input value={newGroup} onChange={e => setNewGroup(e.target.value)} placeholder="-1001234567890" />
            </div>
            <button className="btn-add" type="submit">Добавить группу</button>
          </form>
          <table className="table">
            <thead>
              <tr>
                <th>Chat ID</th>
                <th>Название</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {data?.whitelisted_groups.length === 0 && (
                <tr><td colSpan={3}><div className="empty">Нет разрешённых групп</div></td></tr>
              )}
              {data?.whitelisted_groups.map(g => (
                <tr key={g.chat_id}>
                  <td style={{ fontFamily: 'monospace', color: '#475569' }}>{g.chat_id}</td>
                  <td style={{ color: '#64748b' }}>{g.name ?? '—'}</td>
                  <td>
                    <button className="action-btn btn-delete" onClick={() => deleteGroup(g.chat_id)}>
                      🗑 Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
