import { useState, useEffect, useCallback } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { StatusBadge } from '../components/StatusBadge';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { WorkItem, WorkItemFilters, Case, Workflow } from '../api/types';

const styles = `
  .wf-body { padding: 20px; }
  .container { max-width: 1400px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .container h1 { margin-bottom: 20px; color: #333; font-size: 24px; }
  .filters { display: grid; grid-template-columns: repeat(auto-fit,minmax(200px,1fr)); gap: 12px; margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #eee; }
  .filter-group { display: flex; flex-direction: column; }
  .filter-group label { font-size: 12px; font-weight: 600; color: #666; margin-bottom: 4px; text-transform: uppercase; }
  .filter-group input, .filter-group select { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .filter-group input:focus, .filter-group select:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 2px rgba(0,102,204,.1); }
  .button-group { display: flex; gap: 8px; align-items: flex-end; }
  .button-group button { padding: 8px 16px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .button-group button:hover { background: #0052a3; }
  .button-group .reset { background: #999; }
  .button-group .reset:hover { background: #777; }
  .items-table { width: 100%; border-collapse: collapse; }
  .items-table th { background: #f9f9f9; padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #666; border-bottom: 2px solid #eee; text-transform: uppercase; }
  .items-table td { padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; }
  .items-table tr:hover { background: #fafafa; }
  .item-label { font-weight: 600; color: #333; }
  .item-link { color: #0066cc; text-decoration: none; }
  .item-link:hover { text-decoration: underline; }
  .item-actions { display: flex; gap: 6px; }
  .item-actions button { padding: 6px 10px; border: 1px solid #ddd; background: white; color: #333; border-radius: 3px; cursor: pointer; font-size: 12px; font-weight: 500; }
  .item-actions button:hover { background: #f0f0f0; }
  .item-actions button.complete { background: #10b981; color: white; border-color: #10b981; }
  .item-actions button.complete:hover { background: #059669; }
  .step-progress { font-size: 12px; color: #64748b; white-space: nowrap; }
  .loading-msg { text-align: center; padding: 40px; color: #666; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 20px; border-left: 4px solid #c33; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .details-modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.5); z-index: 1000; justify-content: center; align-items: center; }
  .details-modal.show { display: flex; }
  .modal-content { background: white; border-radius: 8px; padding: 20px; max-width: 500px; max-height: 80vh; overflow-y: auto; box-shadow: 0 20px 25px rgba(0,0,0,.15); position: relative; }
  .modal-content h2 { margin-bottom: 16px; color: #333; }
  .detail-field { margin-bottom: 12px; }
  .detail-field strong { display: block; font-size: 12px; color: #666; margin-bottom: 4px; text-transform: uppercase; }
  .detail-field code { display: block; background: #f5f5f5; padding: 8px; border-radius: 3px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  .modal-close { position: absolute; top: 16px; right: 16px; background: none; border: none; font-size: 20px; cursor: pointer; color: #999; }
  .modal-close:hover { color: #333; }
  .refresh-info { font-size: 12px; color: #999; margin-top: 12px; text-align: right; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .page-header h1 { margin-bottom: 0; }
  .btn-new-task { padding: 8px 18px; background: #10b981; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; }
  .btn-new-task:hover { background: #059669; }
  .standalone-badge { display: inline-block; padding: 2px 7px; background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .new-task-form { display: flex; flex-direction: column; gap: 14px; }
  .new-task-form .form-group { display: flex; flex-direction: column; gap: 4px; }
  .new-task-form label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; }
  .new-task-form input { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .new-task-form input:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 2px rgba(0,102,204,.1); }
  .new-task-form .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
  .new-task-form .form-actions button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .new-task-form .btn-submit { background: #10b981; color: white; }
  .new-task-form .btn-submit:hover { background: #059669; }
  .new-task-form .btn-cancel { background: #e5e7eb; color: #374151; }
  .new-task-form .btn-cancel:hover { background: #d1d5db; }
  @media (max-width: 768px) { .container { padding: 12px; } .filters { grid-template-columns: 1fr; } .items-table { font-size: 12px; } .items-table th, .items-table td { padding: 8px; } .item-actions { flex-direction: column; } .item-actions button { width: 100%; } }
`;

function formatProcessCase(item: WorkItem, wfNameMap: Record<string, string>): string {
  if (!item.process_id && !item.case_id) return '-';
  const name = wfNameMap[item.process_id || ''] ||
    (item.process_id ? item.process_id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '');
  const shortCase = item.case_id ? item.case_id.substring(0, 6).toUpperCase() : '';
  return shortCase ? `${name} #${shortCase}` : name;
}

function getStepLabel(kase: Case, wiId: string): string {
  const idx = (kase.history || []).findIndex((h: any) => h.work_item_id === wiId);
  if (idx === -1) return '';
  return `step ${idx + 1}/${kase.history.length}`;
}

interface NewTaskModalProps { onClose: () => void; onCreated: () => void; }
function NewTaskModal({ onClose, onCreated }: NewTaskModalProps) {
  const [label, setLabel] = useState('');
  const [assignee, setAssignee] = useState('');
  const [deadline, setDeadline] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim() || !assignee.trim()) { setError('Введите описание и исполнителя'); return; }
    setSubmitting(true);
    setError(null);
    try {
      await api.workitems.create({
        label: label.trim(),
        assignee: assignee.trim(),
        deadline: deadline || undefined,
      });
      onCreated();
      onClose();
    } catch (err: any) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="details-modal show" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>Новая задача</h2>
        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
        <form className="new-task-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="ntLabel">Описание *</label>
            <input id="ntLabel" type="text" placeholder="Описание задачи..." value={label}
              onChange={e => setLabel(e.target.value)} autoFocus required />
          </div>
          <div className="form-group">
            <label htmlFor="ntAssignee">Исполнитель *</label>
            <input id="ntAssignee" type="text" placeholder="Роль или агент..." value={assignee}
              onChange={e => setAssignee(e.target.value)} required />
          </div>
          <div className="form-group">
            <label htmlFor="ntDeadline">Срок</label>
            <input id="ntDeadline" type="date" value={deadline} onChange={e => setDeadline(e.target.value)} />
          </div>
          <div className="form-actions">
            <button type="button" className="btn-cancel" onClick={onClose}>Отмена</button>
            <button type="submit" className="btn-submit" disabled={submitting}>
              {submitting ? 'Создание…' : 'Создать'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface DetailsModalProps { item: WorkItem | null; onClose: () => void; }
function DetailsModal({ item, onClose }: DetailsModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className={`details-modal${item ? ' show' : ''}`} id="detailsModal">
      <div className="modal-content">
        <button className="modal-close" onClick={onClose}>✕</button>
        {item && (
          <>
            <h2 id="detailsTitle">Детали: {item.label}</h2>
            <div id="detailsContent">
              <div className="detail-field"><strong>ID</strong><code>{item.work_item_id}</code></div>
              {item.case_id && <div className="detail-field"><strong>ID дела</strong><code>{item.case_id}</code></div>}
              <div className="detail-field"><strong>Входные данные</strong><code>{JSON.stringify(item.input || {}, null, 2)}</code></div>
              <div className="detail-field"><strong>Выходные данные</strong><code>{JSON.stringify(item.output || {}, null, 2)}</code></div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function WorkItems() {
  const token = useToken();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string>('-');
  const [filters, setFilters] = useState<WorkItemFilters>({});
  const [detailItem, setDetailItem] = useState<WorkItem | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [wfNameMap, setWfNameMap] = useState<Record<string, string>>({});
  const [caseCache, setCaseCache] = useState<Record<string, Case>>({});

  // Load workflow names once
  useEffect(() => {
    if (!token) return;
    api.workflows.list().then(wfs => {
      const m: Record<string, string> = {};
      wfs.forEach((wf: Workflow) => { m[wf.id] = wf.name || wf.id; });
      setWfNameMap(m);
    }).catch(() => {});
  }, [token]);

  const loadItems = useCallback(() => {
    if (!token) return;
    api.workitems.list(filters)
      .then(data => {
        setItems(data);
        setLastUpdate(new Date().toLocaleTimeString());
        setError(null);
        setLoading(false);
        // Fetch case data for step progress
        const newCaseIds = data.filter((i: WorkItem) => i.case_id && !caseCache[i.case_id!]).map((i: WorkItem) => i.case_id!);
        newCaseIds.forEach((caseId: string) => {
          api.cases.get(caseId).then(kase => {
            setCaseCache(prev => ({ ...prev, [caseId]: kase }));
          }).catch(() => {});
        });
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token, filters]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadItems(); }, [loadItems]);
  useInterval(loadItems, 10000);

  function completeItem(id: string) {
    if (!confirm('Завершить задачу?')) return;
    api.workitems.complete(id)
      .then(() => loadItems())
      .catch(e => setError(`Ошибка завершения: ${e.message}`));
  }

  const [localFilters, setLocalFilters] = useState<WorkItemFilters>({});

  return (
    <Layout activePage="workitems.html">
      <style>{styles}</style>
      <div className="wf-body">
        <div className="container">
          <div className="page-header">
            <h1>Задачи</h1>
            <button className="btn-new-task" onClick={() => setShowNewTask(true)}>+ Новая задача</button>
          </div>
          {error && <div className="error-banner">{error}</div>}

          <div className="filters">
            <div className="filter-group">
              <label htmlFor="filterAssignee">Исполнитель</label>
              <input id="filterAssignee" type="text" placeholder="Фильтр по исполнителю..."
                value={localFilters.assignee || ''}
                onChange={e => setLocalFilters(f => ({ ...f, assignee: e.target.value }))} />
            </div>
            <div className="filter-group">
              <label htmlFor="filterProcess">ID процесса</label>
              <input id="filterProcess" type="text" placeholder="Фильтр по процессу..."
                value={localFilters.process_id || ''}
                onChange={e => setLocalFilters(f => ({ ...f, process_id: e.target.value }))} />
            </div>
            <div className="filter-group">
              <label htmlFor="filterStatus">Статус</label>
              <select id="filterStatus" value={localFilters.status || ''}
                onChange={e => setLocalFilters(f => ({ ...f, status: e.target.value as any }))}>
                <option value="">Все статусы</option>
                <option value="pending">Ожидает</option>
                <option value="assigned">Назначено</option>
                <option value="running">Выполняется</option>
                <option value="done">Завершено</option>
                <option value="error">Ошибка</option>
              </select>
            </div>
            <div className="filter-group">
              <label htmlFor="filterDeadline">Срок до</label>
              <input id="filterDeadline" type="date"
                value={localFilters.deadline_before || ''}
                onChange={e => setLocalFilters(f => ({ ...f, deadline_before: e.target.value }))} />
            </div>
            <div className="button-group">
              <button onClick={() => setFilters(localFilters)}>Применить</button>
              <button className="reset" onClick={() => { setLocalFilters({}); setFilters({}); }}>Сбросить</button>
            </div>
          </div>

          {loading && <div className="loading-msg">Загрузка…</div>}

          {!loading && items.length === 0 && !error && (
            <div className="empty">Задачи не найдены.</div>
          )}

          {items.length > 0 && (
            <table className="items-table" id="itemsTable">
              <thead>
                <tr>
                  <th>Описание</th>
                  <th>Исполнитель</th>
                  <th>Статус</th>
                  <th>Процесс / Дело</th>
                  <th>Прогресс</th>
                  <th>Срок</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody id="itemsBody">
                {items.map(item => {
                  const kase = item.case_id ? caseCache[item.case_id] : undefined;
                  const progress = kase ? getStepLabel(kase, item.work_item_id) : '-';
                  const processCell = formatProcessCase(item, wfNameMap);
                  const fullTitle = [item.process_id, item.case_id].filter(Boolean).join(' / ');
                  const deadline = item.deadline ? new Date(item.deadline).toLocaleDateString() : '-';
                  return (
                    <tr key={item.work_item_id}>
                      <td><span className="item-label">{item.label}</span></td>
                      <td>{item.assignee || '-'}</td>
                      <td><StatusBadge status={item.status} /></td>
                      <td>
                        {(item.process_id || item.case_id)
                          ? <span title={fullTitle} style={{ cursor: 'default' }}>{processCell}</span>
                          : <span className="standalone-badge">Автономная</span>}
                      </td>
                      <td className="step-progress"
                          data-case-id={item.case_id || ''}
                          data-wi-id={item.work_item_id}>
                        {progress}
                      </td>
                      <td>{deadline}</td>
                      <td className="item-actions">
                        <button className="complete" onClick={() => completeItem(item.work_item_id)}>Завершить</button>
                        <button onClick={() => setDetailItem(item)}>Детали</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div className="refresh-info">
            Авто-обновление 10с • Последнее: <span id="lastUpdate">{lastUpdate}</span>
          </div>
        </div>
      </div>

      {showNewTask && <NewTaskModal onClose={() => setShowNewTask(false)} onCreated={loadItems} />}
      <DetailsModal item={detailItem} onClose={() => setDetailItem(null)} />
    </Layout>
  );
}
