import { useState, useEffect, useCallback } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { Reminder, ReminderStatus, Agent } from '../api/types';

const styles = `
  .rm-body { padding: 20px; }
  .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .page-header h1 { color: #333; font-size: 24px; }
  .btn-new { padding: 8px 18px; background: #6366f1; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; }
  .btn-new:hover { background: #4f46e5; }
  .filters { display: flex; gap: 12px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #eee; flex-wrap: wrap; }
  .filters select { padding: 7px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
  .table { width: 100%; border-collapse: collapse; }
  .table th { background: #f9f9f9; padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #666; border-bottom: 2px solid #eee; text-transform: uppercase; }
  .table td { padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; }
  .table tr:hover { background: #fafafa; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge-pending { background: #fef3c7; color: #92400e; }
  .badge-sent { background: #dbeafe; color: #1e40af; }
  .badge-acknowledged { background: #d1fae5; color: #065f46; }
  .badge-overdue { background: #fee2e2; color: #991b1b; }
  .badge-gui { background: #f1f5f9; color: #475569; }
  .badge-telegram { background: #e0f2fe; color: #0369a1; }
  .badge-email { background: #faf5ff; color: #6b21a8; }
  .badge-standalone { background: #f0fdf4; color: #15803d; }
  .badge-process { background: #eff6ff; color: #1d4ed8; }
  .actions { display: flex; gap: 6px; }
  .actions button { padding: 5px 10px; border: 1px solid #ddd; background: white; border-radius: 3px; cursor: pointer; font-size: 12px; }
  .actions button:hover { background: #f0f0f0; }
  .actions .ack { background: #10b981; color: white; border-color: #10b981; }
  .actions .ack:hover { background: #059669; }
  .actions .del { background: #ef4444; color: white; border-color: #ef4444; }
  .actions .del:hover { background: #dc2626; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }
  .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.5); z-index: 1000; display: flex; justify-content: center; align-items: center; }
  .modal { background: white; border-radius: 8px; padding: 24px; width: 480px; max-width: 95vw; box-shadow: 0 20px 25px rgba(0,0,0,.15); }
  .modal h2 { margin-bottom: 18px; color: #333; }
  .form-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
  .form-group label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; }
  .form-group input, .form-group select, .form-group textarea { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .form-group input:focus, .form-group select:focus, .form-group textarea:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,.1); }
  .form-group textarea { resize: vertical; min-height: 72px; }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .form-actions button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .btn-submit { background: #6366f1; color: white; }
  .btn-submit:hover { background: #4f46e5; }
  .btn-cancel-form { background: #e5e7eb; color: #374151; }
  .btn-cancel-form:hover { background: #d1d5db; }
  .refresh-info { font-size: 12px; color: #999; margin-top: 12px; text-align: right; }
`;

const STATUS_LABELS: Record<ReminderStatus, string> = {
  pending: 'Ожидает',
  sent: 'Отправлено',
  acknowledged: 'Принято',
  overdue: 'Просрочено',
};

function statusBadge(s: ReminderStatus) {
  return <span className={`badge badge-${s}`}>{STATUS_LABELS[s] ?? s}</span>;
}

interface NewReminderModalProps { onClose: () => void; onCreated: () => void; }
function NewReminderModal({ onClose, onCreated }: NewReminderModalProps) {
  const [recipient, setRecipient] = useState('');
  const [message, setMessage] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [channel, setChannel] = useState<'gui' | 'telegram' | 'email'>('gui');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [people, setPeople] = useState<{ name: string; label: string; group: string }[]>([]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    Promise.all([
      api.people.list().catch(() => []),
      api.agents.list().catch(() => [] as Agent[]),
    ]).then(([ps, ags]) => {
      const opts = [
        ...ps.map((p: any) => ({ name: p.name, label: p.name, group: 'Люди' })),
        ...ags.map((a: Agent) => ({ name: a.name, label: a.name, group: 'Агенты' })),
      ];
      setPeople(opts);
      if (opts.length > 0 && !recipient) setRecipient(opts[0].name);
    });
    return () => document.removeEventListener('keydown', h);
  }, [onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!recipient || !message.trim() || !scheduledAt) {
      setError('Заполните получателя, сообщение и время');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.reminders.create({
        recipient,
        message: message.trim(),
        scheduled_at: new Date(scheduledAt).toISOString(),
        channel,
        type: 'standalone',
      });
      onCreated();
      onClose();
    } catch (err: any) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>Новое напоминание</h2>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Получатель *</label>
            <select value={recipient} onChange={e => setRecipient(e.target.value)} autoFocus required>
              {people.length === 0 && <option value="">Загрузка…</option>}
              {['Люди', 'Агенты'].map(g => {
                const grp = people.filter(p => p.group === g);
                if (!grp.length) return null;
                return (
                  <optgroup key={g} label={g}>
                    {grp.map(p => <option key={p.name} value={p.name}>{p.label}</option>)}
                  </optgroup>
                );
              })}
            </select>
          </div>
          <div className="form-group">
            <label>Сообщение *</label>
            <textarea placeholder="Текст напоминания..." value={message}
              onChange={e => setMessage(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Время отправки *</label>
            <input type="datetime-local" value={scheduledAt}
              onChange={e => setScheduledAt(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Канал</label>
            <select value={channel} onChange={e => setChannel(e.target.value as any)}>
              <option value="gui">GUI</option>
              <option value="telegram">Telegram</option>
              <option value="email">Email</option>
            </select>
          </div>
          <div className="form-actions">
            <button type="button" className="btn-cancel-form" onClick={onClose}>Отмена</button>
            <button type="submit" className="btn-submit" disabled={submitting}>
              {submitting ? 'Создание…' : 'Создать'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function Reminders() {
  const token = useToken();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState('-');
  const [statusFilter, setStatusFilter] = useState<ReminderStatus | ''>('');
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(() => {
    if (!token) return;
    api.reminders.list(statusFilter ? { status: statusFilter } : undefined)
      .then(data => {
        setReminders(data);
        setLastUpdate(new Date().toLocaleTimeString());
        setError(null);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token, statusFilter]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 15000);

  async function acknowledge(id: string) {
    try {
      await api.reminders.acknowledge(id);
      load();
    } catch (e: any) { setError(e.message); }
  }

  async function remove(id: string) {
    if (!confirm('Удалить напоминание?')) return;
    try {
      await api.reminders.delete(id);
      load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <Layout activePage="reminders.html">
      <style>{styles}</style>
      <div className="rm-body">
        <div className="container">
          <div className="page-header">
            <h1>Напоминания</h1>
            <button className="btn-new" onClick={() => setShowNew(true)}>+ Новое напоминание</button>
          </div>

          {error && <div className="error-banner">{error}</div>}

          <div className="filters">
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)}>
              <option value="">Все статусы</option>
              <option value="pending">Ожидает</option>
              <option value="sent">Отправлено</option>
              <option value="acknowledged">Принято</option>
              <option value="overdue">Просрочено</option>
            </select>
          </div>

          {loading && <div className="empty">Загрузка…</div>}

          {!loading && reminders.length === 0 && (
            <div className="empty">Напоминания не найдены.</div>
          )}

          {reminders.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Сообщение</th>
                  <th>Получатель</th>
                  <th>Время</th>
                  <th>Канал</th>
                  <th>Тип</th>
                  <th>Статус</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {reminders.map(r => (
                  <tr key={r.reminder_id}>
                    <td style={{ maxWidth: 300 }}>{r.message}</td>
                    <td>{r.recipient}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {new Date(r.scheduled_at).toLocaleString()}
                    </td>
                    <td><span className={`badge badge-${r.channel}`}>{r.channel}</span></td>
                    <td>
                      <span className={`badge badge-${r.type === 'standalone' ? 'standalone' : 'process'}`}>
                        {r.type === 'standalone' ? 'Разовое' : 'Процесс'}
                      </span>
                    </td>
                    <td>{statusBadge(r.status)}</td>
                    <td>
                      <div className="actions">
                        {(r.status === 'sent' || r.status === 'pending') && (
                          <button className="ack" onClick={() => acknowledge(r.reminder_id)}>Принять</button>
                        )}
                        <button className="del" onClick={() => remove(r.reminder_id)}>Удалить</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="refresh-info">
            Авто-обновление 15с • Последнее: {lastUpdate}
          </div>
        </div>
      </div>

      {showNew && <NewReminderModal onClose={() => setShowNew(false)} onCreated={load} />}
    </Layout>
  );
}
