/**
 * MyTasks — personal inbox of the current user/agent.
 * Work items grouped by urgency: overdue / due soon / in progress.
 */
import { useState, useCallback, useEffect } from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { WorkItem } from '../api/types';

const lang = document.documentElement.lang || 'ru';

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

function fmtDeadline(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  if (diff < 0) return lang === 'ru' ? 'Просрочено' : 'Overdue';
  const h = Math.floor(diff / 3_600_000);
  if (h < 24) return lang === 'ru' ? `через ${h}ч` : `in ${h}h`;
  return lang === 'ru' ? `через ${Math.floor(h / 24)}д` : `in ${Math.floor(h / 24)}d`;
}

type Urgency = 'overdue' | 'soon' | 'inProgress';

function urgencyOf(wi: WorkItem): Urgency {
  if (!wi.deadline) return 'inProgress';
  const diff = new Date(wi.deadline).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  if (diff < 6 * 3_600_000) return 'soon';
  return 'inProgress';
}

const GROUP_META: Record<Urgency, { label: string; labelEn: string; color: string; bg: string }> = {
  overdue:    { label: 'Просрочено',     labelEn: 'Overdue',     color: '#ef4444', bg: '#fef2f2' },
  soon:       { label: 'Скоро дедлайн',  labelEn: 'Due soon',    color: '#f59e0b', bg: '#fffbeb' },
  inProgress: { label: 'В работе',       labelEn: 'In progress', color: '#3b82f6', bg: '#eff6ff' },
};

const CSS = `
  .mt-root { padding: 24px; max-width: 860px; margin: 0 auto; }
  .mt-header { margin-bottom: 20px; }
  .mt-header h1 { font-size: 22px; font-weight: 700; color: #0f172a; }
  .mt-header p { font-size: 14px; color: #64748b; margin-top: 4px; }

  .mt-group { margin-bottom: 24px; }
  .mt-group-title { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .mt-group-title h2 { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  .mt-group-count { font-size: 12px; background: #f1f5f9; color: #64748b; padding: 1px 8px; border-radius: 10px; }

  .mt-item { background: #fff; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.07); margin-bottom: 8px; padding: 14px 18px; display: flex; align-items: flex-start; gap: 14px; border-left: 4px solid transparent; }
  .mt-item.overdue    { border-left-color: #ef4444; }
  .mt-item.soon       { border-left-color: #f59e0b; }
  .mt-item.inProgress { border-left-color: #3b82f6; }

  .mt-item-body { flex: 1; min-width: 0; }
  .mt-item-label { font-size: 15px; font-weight: 600; color: #1e293b; }
  .mt-item-meta { display: flex; gap: 12px; margin-top: 4px; flex-wrap: wrap; }
  .mt-item-meta span { font-size: 12px; color: #64748b; }
  .mt-item-meta b { color: #334155; }

  .mt-item-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
  .btn-complete { padding: 6px 14px; background: #16a34a; color: #fff; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn-complete:hover { background: #15803d; }
  .btn-complete:disabled { opacity: .5; cursor: default; }
  .deadline-badge { font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 6px; }
  .deadline-badge.overdue    { background: #fee2e2; color: #dc2626; }
  .deadline-badge.soon       { background: #fef3c7; color: #d97706; }
  .deadline-badge.inProgress { background: #dbeafe; color: #2563eb; }

  .mt-empty { text-align: center; padding: 60px 20px; color: #94a3b8; }
  .mt-empty .icon { font-size: 40px; margin-bottom: 12px; }
  .mt-error { background: #fee2e2; color: #c33; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; border-left: 3px solid #ef4444; font-size: 13px; }

  .assignee-filter { margin-bottom: 16px; }
  .assignee-filter label { font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; margin-right: 8px; }
  .assignee-filter input { padding: 6px 12px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 13px; width: 220px; }
`;

export function MyTasks() {
  const token = useToken();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [completing, setCompleting] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    if (!token) return;
    const filters: Record<string, string> = { status: 'pending' };
    if (assigneeFilter.trim()) filters.assignee = assigneeFilter.trim();
    api.workitems.list(filters as any)
      .then(data => { setItems(Array.isArray(data) ? data : []); setLoading(false); setError(null); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token, assigneeFilter]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 15000);

  async function complete(wi: WorkItem) {
    setCompleting(prev => new Set([...prev, wi.work_item_id]));
    try {
      await api.workitems.complete(wi.work_item_id);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCompleting(prev => { const s = new Set(prev); s.delete(wi.work_item_id); return s; });
    }
  }

  // Group by urgency
  const groups: Record<Urgency, WorkItem[]> = { overdue: [], soon: [], inProgress: [] };
  items.forEach(wi => groups[urgencyOf(wi)].push(wi));

  const isEmpty = items.length === 0 && !loading;

  return (
    <Layout activePage="my-tasks.html">
      <style>{CSS}</style>
      <div className="mt-root">
        <div className="mt-header">
          <h1>{lang === 'ru' ? 'Мои задачи' : 'My Tasks'}</h1>
          <p>{lang === 'ru' ? 'Задачи, ожидающие вашего действия' : 'Tasks waiting for your action'}</p>
        </div>

        <div className="assignee-filter">
          <label>{lang === 'ru' ? 'Исполнитель' : 'Assignee'}</label>
          <input
            placeholder={lang === 'ru' ? 'Имя роли или агента…' : 'Role or agent name…'}
            value={assigneeFilter}
            onChange={e => setAssigneeFilter(e.target.value)}
          />
        </div>

        {error && <div className="mt-error">{error}</div>}

        {isEmpty && (
          <div className="mt-empty">
            <div className="icon">✓</div>
            <div>{lang === 'ru' ? 'Нет ожидающих задач' : 'No pending tasks'}</div>
          </div>
        )}

        {(['overdue', 'soon', 'inProgress'] as Urgency[]).map(g => {
          const gItems = groups[g];
          if (gItems.length === 0) return null;
          const meta = GROUP_META[g];
          return (
            <div key={g} className="mt-group">
              <div className="mt-group-title">
                <h2 style={{ color: meta.color }}>{lang === 'ru' ? meta.label : meta.labelEn}</h2>
                <span className="mt-group-count">{gItems.length}</span>
              </div>
              {gItems.map(wi => {
                const dl = fmtDeadline(wi.deadline);
                return (
                  <div key={wi.work_item_id} className={`mt-item ${g}`}>
                    <div className="mt-item-body">
                      <div className="mt-item-label">{wi.label}</div>
                      <div className="mt-item-meta">
                        <span>{lang === 'ru' ? 'Исполнитель: ' : 'Assignee: '}<b>{wi.assignee}</b></span>
                        {wi.process_id && (
                          <span>{lang === 'ru' ? 'Процесс: ' : 'Process: '}<b>{wi.process_id}</b></span>
                        )}
                        <span>{lang === 'ru' ? 'Создано: ' : 'Created: '}<b>{fmtTime(wi.created_at)}</b></span>
                      </div>
                    </div>
                    <div className="mt-item-actions">
                      {dl && <span className={`deadline-badge ${g}`}>{dl}</span>}
                      <button
                        className="btn-complete"
                        disabled={completing.has(wi.work_item_id)}
                        onClick={() => complete(wi)}
                      >
                        {completing.has(wi.work_item_id)
                          ? (lang === 'ru' ? 'Сохранение…' : 'Saving…')
                          : (lang === 'ru' ? 'Выполнено' : 'Done')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </Layout>
  );
}
