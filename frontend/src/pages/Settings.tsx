/**
 * Settings page — Audit Log + Autonomy Matrix (closes #294)
 * Route: /settings
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import './Settings.css';

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

// ── Branding Tab ───────────────────────────────────────────────────────────────

interface BrandingData {
  product_name: string;
  assistant_agent_id: string;
  agent_display_names: Record<string, string>;
  theme: { primary_color: string; accent_color: string; logo_url: string };
}

const BRAND_DEFAULTS: BrandingData = {
  product_name: 'Konoha WE',
  assistant_agent_id: '',
  agent_display_names: {},
  theme: { primary_color: '#6366f1', accent_color: '#f59e0b', logo_url: '' },
};

function BrandingTab() {
  const [data, setData] = useState<BrandingData>(BRAND_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [knownAgents, setKnownAgents] = useState<string[]>([]);

  useEffect(() => {
    fetch(`${BASE}/branding`)
      .then(r => r.json())
      .then(d => setData({ ...BRAND_DEFAULTS, ...d, theme: { ...BRAND_DEFAULTS.theme, ...(d.theme ?? {}) }, agent_display_names: d.agent_display_names ?? {} }))
      .catch(console.error)
      .finally(() => setLoading(false));
    fetch(`${BASE}/agents`)
      .then(r => r.ok ? r.json() : [])
      .then((agents: { id: string }[]) => setKnownAgents(agents.map(a => a.id)))
      .catch(() => {});
  }, []);

  function set(path: string, value: string) {
    if (path.startsWith('theme.')) {
      const key = path.slice(6);
      setData(d => ({ ...d, theme: { ...d.theme, [key]: value } }));
    } else if (path.startsWith('agent.')) {
      const key = path.slice(6);
      setData(d => ({ ...d, agent_display_names: { ...d.agent_display_names, [key]: value } }));
    } else {
      setData(d => ({ ...d, [path]: value }));
    }
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/branding`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      alert(`Ошибка: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="audit-empty">Загрузка…</div>;

  return (
    <div>
      <div className="settings-h2">Брендинг</div>
      <p className="settings-desc">Настройте имя продукта, ассистента и визуальное оформление для корпоративного использования.</p>

      <div className="brand-row">
        <div className="brand-field">
          <label className="brand-label">Название продукта</label>
          <input className="brand-input" value={data.product_name} onChange={e => set('product_name', e.target.value)} />
        </div>
        <div className="brand-field">
          <label className="brand-label">ID агента-ассистента</label>
          <input className="brand-input" value={data.assistant_agent_id} onChange={e => set('assistant_agent_id', e.target.value)} placeholder="ID агента из раздела Команда" />
          <div className="brand-hint">Имя и аватар берутся из записи агента в команде.</div>
        </div>
      </div>

      <div className="brand-section">Тема оформления</div>
      <div className="brand-row">
        <div className="brand-field">
          <label className="brand-label">Основной цвет</label>
          <div className="brand-color">
            <input type="color" value={data.theme.primary_color} onChange={e => set('theme.primary_color', e.target.value)} />
            <input className="brand-input" value={data.theme.primary_color} onChange={e => set('theme.primary_color', e.target.value)} placeholder="#6366f1" style={{ flex: 1 }} />
          </div>
        </div>
        <div className="brand-field">
          <label className="brand-label">Акцентный цвет</label>
          <div className="brand-color">
            <input type="color" value={data.theme.accent_color} onChange={e => set('theme.accent_color', e.target.value)} />
            <input className="brand-input" value={data.theme.accent_color} onChange={e => set('theme.accent_color', e.target.value)} placeholder="#f59e0b" style={{ flex: 1 }} />
          </div>
        </div>
      </div>
      <div className="brand-field">
        <label className="brand-label">URL логотипа</label>
        <input className="brand-input" value={data.theme.logo_url} onChange={e => set('theme.logo_url', e.target.value)} placeholder="https://..." />
        <div className="brand-hint">Если задан — показывается в шапке вместо текстового названия.</div>
      </div>

      <div className="brand-section">Имена агентов (display names)</div>
      <p className="brand-hint" style={{ marginBottom: 12 }}>Отображаемые имена агентов. Не меняют API-идентификаторы и MCP-инструменты.</p>
      {knownAgents.map(id => (
        <div className="brand-row" key={id}>
          <div className="brand-field" style={{ maxWidth: 120 }}>
            <label className="brand-label">{id}</label>
            <input className="brand-input" style={{ fontFamily: 'monospace', fontSize: 11, color: '#94a3b8', background: '#f1f5f9' }} value={id} readOnly />
          </div>
          <div className="brand-field">
            <label className="brand-label">Display name</label>
            <input className="brand-input" value={data.agent_display_names[id] ?? ''} onChange={e => set(`agent.${id}`, e.target.value)} placeholder={id} />
          </div>
        </div>
      ))}

      <div className="brand-save">
        {saved && <span className="brand-saved">✓ Сохранено</span>}
        <button className="audit-btn" onClick={save} disabled={saving}>{saving ? 'Сохранение…' : 'Сохранить'}</button>
      </div>
    </div>
  );
}

// ── Setup Tab ──────────────────────────────────────────────────────────────────

function SetupTab() {
  const [status, setStatus] = useState<{ complete: boolean; missing_fields: string[] } | null>(null);
  const [showWizard, setShowWizard] = useState(false);

  useEffect(() => {
    fetch(`${BASE}/setup/status`)
      .then(r => r.json())
      .then(setStatus)
      .catch(console.error);
  }, [showWizard]);

  if (showWizard) {
    // Dynamically import SetupWizard to avoid circular dependency
    const { SetupWizard } = require('../components/SetupWizard');
    return <SetupWizard onComplete={() => { setShowWizard(false); }} />;
  }

  return (
    <div>
      <div className="settings-h2">Первичная настройка</div>
      <p className="settings-desc">Повторный доступ к мастеру первичной настройки системы.</p>

      {status && (
        <div className="setup-status">
          Статус:{' '}
          {status.complete
            ? <span className="ok">✓ Настройка завершена</span>
            : <span className="warn">⚠ Настройка не завершена</span>}
        </div>
      )}

      {status && !status.complete && status.missing_fields.length > 0 && (
        <div className="setup-missing">
          Не заполнены поля: {status.missing_fields.join(', ')}
        </div>
      )}

      <button className="setup-link" onClick={() => {
        if (status?.complete) {
          if (!window.confirm('Мастер настройки уже завершён. Повторный запуск перезапишет текущие параметры (включая admin token). Продолжить?')) return;
        }
        setShowWizard(true);
      }}>
        {status?.complete ? 'Повторно запустить мастер настройки' : 'Запустить мастер настройки'}
      </button>
    </div>
  );
}

// ── Settings Page ──────────────────────────────────────────────────────────────

type Tab = 'audit' | 'autonomy' | 'branding' | 'setup';

export function Settings() {
  const [tab, setTab] = useState<Tab>('audit');

  return (
    <>
      <div className="settings-root">
        <div className="settings-tabs">
          <button className={`settings-tab${tab === 'audit' ? ' active' : ''}`} onClick={() => setTab('audit')}>
            Журнал действий
          </button>
          <button className={`settings-tab${tab === 'autonomy' ? ' active' : ''}`} onClick={() => setTab('autonomy')}>
            Автономность
          </button>
          <button className={`settings-tab${tab === 'branding' ? ' active' : ''}`} onClick={() => setTab('branding')}>
            Брендинг
          </button>
          <button className={`settings-tab${tab === 'setup' ? ' active' : ''}`} onClick={() => setTab('setup')}>
            Первичная настройка
          </button>
        </div>
        {tab === 'audit' && <AuditLog />}
        {tab === 'autonomy' && <AutonomyMatrix />}
        {tab === 'branding' && <BrandingTab />}
        {tab === 'setup' && <SetupTab />}
      </div>
    </>
  );
}
