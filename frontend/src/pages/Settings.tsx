/**
 * Settings page — Audit Log + Autonomy Matrix (closes #294)
 * Route: /settings
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';

const BASE = '/api';

// ── Types ──────────────────────────────────────────────────────────────────────

type AutonomyLevel = 'auto' | 'confirm' | 'disabled';

interface AuditEntry {
  timestamp: string;
  session_id: string;
  action_type: string;
  parameters: string;
  result: 'ok' | 'blocked' | 'error' | 'requires_confirm';
  agent_chain: string;
  error?: string;
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const CSS = `
  .settings-root { max-width: 900px; margin: 0 auto; padding: 24px; }
  .settings-tabs { display: flex; gap: 2px; border-bottom: 1px solid #e2e8f0; margin-bottom: 24px; }
  .settings-tab { padding: 8px 18px; border: none; background: none; color: #64748b; font-size: 14px; font-weight: 500; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .settings-tab.active { color: #1d4ed8; border-bottom-color: #1d4ed8; }
  .settings-tab:hover:not(.active) { color: #1e293b; }
  .settings-h2 { font-size: 16px; font-weight: 600; color: #0f172a; margin-bottom: 16px; }
  .settings-desc { font-size: 13px; color: #64748b; margin-bottom: 20px; }

  /* Audit log */
  .audit-filters { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; align-items: flex-end; }
  .audit-filter-group { display: flex; flex-direction: column; gap: 4px; }
  .audit-filter-label { font-size: 11px; color: #64748b; font-weight: 500; }
  .audit-filter-input { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; color: #1e293b; font-size: 13px; padding: 6px 10px; outline: none; }
  .audit-filter-input:focus { border-color: #6366f1; }
  .audit-btn { background: #6366f1; border: none; color: white; border-radius: 6px; padding: 7px 14px; cursor: pointer; font-size: 13px; font-weight: 600; align-self: flex-end; }
  .audit-btn:hover { background: #4f46e5; }
  .audit-btn.secondary { background: #f1f5f9; color: #475569; }
  .audit-btn.secondary:hover { background: #e2e8f0; }
  .audit-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .audit-table th { padding: 8px 10px; text-align: left; border-bottom: 2px solid #e2e8f0; color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  .audit-table td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  .audit-table tr:hover td { background: #f8fafc; }
  .audit-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .audit-badge.ok { background: #dcfce7; color: #15803d; }
  .audit-badge.error { background: #fee2e2; color: #dc2626; }
  .audit-badge.blocked { background: #fef3c7; color: #b45309; }
  .audit-badge.requires_confirm { background: #ede9fe; color: #6d28d9; }
  .audit-empty { padding: 32px; text-align: center; color: #94a3b8; font-size: 13px; }
  .audit-params { font-family: monospace; font-size: 11px; color: #475569; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Autonomy matrix */
  .autonomy-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .autonomy-table th { padding: 10px 14px; text-align: left; border-bottom: 2px solid #e2e8f0; color: #64748b; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
  .autonomy-table td { padding: 10px 14px; border-bottom: 1px solid #f1f5f9; }
  .autonomy-table tr:hover td { background: #f8fafc; }
  .autonomy-action { font-weight: 600; color: #1e293b; font-family: monospace; font-size: 12px; }
  .autonomy-select { border: 1px solid #e2e8f0; border-radius: 6px; background: #f8fafc; color: #1e293b; font-size: 12px; padding: 4px 8px; cursor: pointer; outline: none; }
  .autonomy-select:focus { border-color: #6366f1; }
  .autonomy-select:disabled { opacity: .6; cursor: not-allowed; background: #f1f5f9; }
  .autonomy-hardcoded { font-size: 11px; color: #94a3b8; font-style: italic; }
  .autonomy-save { display: flex; justify-content: flex-end; margin-top: 16px; gap: 8px; align-items: center; }
  .autonomy-saved { font-size: 12px; color: #15803d; }
`;

const HARDCODED_ACTIONS = new Set(['data_delete']);

const ACTION_LABELS: Record<string, string> = {
  issue_create: 'Создание GitHub issue',
  issue_label: 'Добавление меток к issue',
  workflow_create: 'Создание workflow',
  workflow_delete: 'Удаление workflow',
  data_delete: 'Удаление данных',
  agent_restart: 'Перезапуск агента',
  agent_deploy: 'Деплой агента',
  highlight: 'Highlight элемента на странице',
  navigate: 'Навигация по страницам',
  search: 'Поиск в системе',
};

// ── Audit Log Tab ──────────────────────────────────────────────────────────────

function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ action_type: '', agent: '', from_date: '', to_date: '', limit: '100' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.action_type) params.set('action_type', filters.action_type);
      if (filters.agent) params.set('agent', filters.agent);
      if (filters.from_date) params.set('from_date', filters.from_date);
      if (filters.to_date) params.set('to_date', filters.to_date);
      if (filters.limit) params.set('limit', filters.limit);
      const res = await fetch(`${BASE}/audit?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEntries(await res.json());
    } catch (e: any) {
      console.error('audit load error:', e.message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(); }, []);

  function fmtTime(ts: string) {
    try { return new Date(ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' }); }
    catch { return ts; }
  }

  return (
    <div>
      <div className="settings-h2">Журнал автономных действий</div>
      <p className="settings-desc">Все действия, выполненные или заблокированные ассистентом. Запись хранится в Redis stream konoha:audit.</p>

      <div className="audit-filters">
        <div className="audit-filter-group">
          <span className="audit-filter-label">Тип действия</span>
          <input className="audit-filter-input" style={{ width: 160 }} value={filters.action_type}
            onChange={e => setFilters(f => ({ ...f, action_type: e.target.value }))}
            placeholder="issue_create, search…" />
        </div>
        <div className="audit-filter-group">
          <span className="audit-filter-label">Агент</span>
          <input className="audit-filter-input" style={{ width: 120 }} value={filters.agent}
            onChange={e => setFilters(f => ({ ...f, agent: e.target.value }))}
            placeholder="assistant" />
        </div>
        <div className="audit-filter-group">
          <span className="audit-filter-label">От</span>
          <input type="date" className="audit-filter-input" value={filters.from_date}
            onChange={e => setFilters(f => ({ ...f, from_date: e.target.value }))} />
        </div>
        <div className="audit-filter-group">
          <span className="audit-filter-label">До</span>
          <input type="date" className="audit-filter-input" value={filters.to_date}
            onChange={e => setFilters(f => ({ ...f, to_date: e.target.value }))} />
        </div>
        <div className="audit-filter-group">
          <span className="audit-filter-label">Лимит</span>
          <input className="audit-filter-input" style={{ width: 70 }} type="number" value={filters.limit}
            onChange={e => setFilters(f => ({ ...f, limit: e.target.value }))} min={1} max={1000} />
        </div>
        <button className="audit-btn" onClick={load} disabled={loading}>{loading ? 'Загрузка…' : 'Применить'}</button>
        <button className="audit-btn secondary" onClick={() => { setFilters({ action_type: '', agent: '', from_date: '', to_date: '', limit: '100' }); }}>
          Сбросить
        </button>
      </div>

      {entries.length === 0 && !loading && (
        <div className="audit-empty">Записей не найдено</div>
      )}

      {entries.length > 0 && (
        <table className="audit-table">
          <thead>
            <tr>
              <th>Время</th>
              <th>Тип действия</th>
              <th>Параметры</th>
              <th>Результат</th>
              <th>Агент</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i}>
                <td style={{ whiteSpace: 'nowrap', color: '#64748b' }}>{fmtTime(e.timestamp)}</td>
                <td><code style={{ fontSize: 11 }}>{e.action_type}</code></td>
                <td><div className="audit-params" title={e.parameters}>{e.parameters}</div></td>
                <td>
                  <span className={`audit-badge ${e.result}`}>{e.result}</span>
                  {e.error && <div style={{ fontSize: 11, color: '#dc2626', marginTop: 2 }}>{e.error}</div>}
                </td>
                <td style={{ color: '#475569' }}>{e.agent_chain}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Autonomy Matrix Tab ────────────────────────────────────────────────────────

function AutonomyMatrix() {
  const [matrix, setMatrix] = useState<Record<string, AutonomyLevel>>({});
  const [draft, setDraft] = useState<Record<string, AutonomyLevel>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch(`${BASE}/config/autonomy`)
      .then(r => r.json())
      .then(data => { setMatrix(data); setDraft(data); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      // Only send changed, non-hardcoded values
      const changes: Record<string, AutonomyLevel> = {};
      for (const [k, v] of Object.entries(draft)) {
        if (!HARDCODED_ACTIONS.has(k) && v !== matrix[k]) changes[k] = v;
      }
      const res = await fetch(`${BASE}/config/autonomy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMatrix({ ...matrix, ...changes });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      alert(`Ошибка сохранения: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  const actionTypes = Object.keys(ACTION_LABELS);

  return (
    <div>
      <div className="settings-h2">Матрица автономности</div>
      <p className="settings-desc">
        Управляет тем, как ассистент выполняет действия: автоматически, с подтверждением или заблокировано.
        Удаление данных всегда требует подтверждения (изменить нельзя).
      </p>

      {loading ? (
        <div className="audit-empty">Загрузка…</div>
      ) : (
        <>
          <table className="autonomy-table">
            <thead>
              <tr>
                <th>Действие</th>
                <th>Описание</th>
                <th>Уровень</th>
              </tr>
            </thead>
            <tbody>
              {actionTypes.map(action => {
                const hardcoded = HARDCODED_ACTIONS.has(action);
                const current = draft[action] ?? 'confirm';
                return (
                  <tr key={action}>
                    <td><span className="autonomy-action">{action}</span></td>
                    <td style={{ color: '#475569' }}>{ACTION_LABELS[action]}</td>
                    <td>
                      {hardcoded ? (
                        <div>
                          <span className="audit-badge requires_confirm">confirm</span>
                          <span className="autonomy-hardcoded"> (обязательно)</span>
                        </div>
                      ) : (
                        <select
                          className="autonomy-select"
                          value={current}
                          onChange={e => setDraft(d => ({ ...d, [action]: e.target.value as AutonomyLevel }))}
                        >
                          <option value="auto">auto — автоматически</option>
                          <option value="confirm">confirm — требует подтверждения</option>
                          <option value="disabled">disabled — запрещено</option>
                        </select>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="autonomy-save">
            {saved && <span className="autonomy-saved">✓ Сохранено</span>}
            <button className="audit-btn secondary" onClick={() => setDraft({ ...matrix })}>Отмена</button>
            <button className="audit-btn" onClick={save} disabled={saving}>{saving ? 'Сохранение…' : 'Сохранить'}</button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Settings Page ──────────────────────────────────────────────────────────────

type Tab = 'audit' | 'autonomy';

export function Settings() {
  const [tab, setTab] = useState<Tab>('audit');

  return (
    <>
      <style>{CSS}</style>
      <div className="settings-root">
        <div className="settings-tabs">
          <button className={`settings-tab${tab === 'audit' ? ' active' : ''}`} onClick={() => setTab('audit')}>
            Журнал действий
          </button>
          <button className={`settings-tab${tab === 'autonomy' ? ' active' : ''}`} onClick={() => setTab('autonomy')}>
            Автономность
          </button>
        </div>
        {tab === 'audit' ? <AuditLog /> : <AutonomyMatrix />}
      </div>
    </>
  );
}
