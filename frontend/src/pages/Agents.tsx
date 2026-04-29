import { useState } from 'react';
import { api } from '../api/client';
import type { Agent } from '../api/types';
import { agentStyles } from '../components/agents/agentStyles';
import { AgentTypeBadge } from '../components/agents/AgentTypeBadge';
import { NewAgentModal } from '../components/agents/NewAgentModal';
import { TmuxModal } from '../components/agents/TmuxModal';
import { EditAgentModal } from '../components/agents/EditAgentModal';
import { useAgents } from '../hooks/useAgents';
import { useAgentFilters } from '../hooks/useAgentFilters';
import { busColor, lifecycleColor, formatUptime, getAgentType, BUS_STATUS_LABELS, LIFECYCLE_STATUS_LABELS } from '../components/agents/agentUtils';

export function Agents() {
  const { agents, loading, error: loadError, lastUpdate, load } = useAgents();
  const { search, setSearch, filterBus, setFilterBus, filterLifecycle, setFilterLifecycle, filterModel, setFilterModel, sortBy, setSortBy, filteredAgents, allModels } = useAgentFilters(agents);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [tmuxAgent, setTmuxAgent] = useState<string | null>(null);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);

  const error = loadError || actionError;

  async function action(id: string, fn: () => Promise<unknown>, label: string, isProtected?: boolean) {
    if (label === 'Delete') {
      if (isProtected) { setActionError(`Агент "${id}" является системным и не может быть удалён.`); return; }
      if (!confirm(`Удалить агента "${id}"? Это действие необратимо.`)) return;
    }
    if ((label === 'Start' || label === 'Stop' || label === 'Restart') && isProtected) {
      if (!confirm(`Агент "${id}" — системный. Управление через konoha.service / systemd.\nПродолжить?`)) return;
    }
    try { await fn(); load(); } catch (e: any) { setActionError(e.message); }
  }

  return (
    <>
      <style>{agentStyles}</style>
      <div style={{ display: 'flex', height: 'calc(100vh - 105px)' }}>
        <div className="ag-body" style={{ flex: 1, overflowY: 'auto' }}>
          <div className="container">
            <div className="page-header">
              <h1>Агенты</h1>
              <button className="btn-new" onClick={() => setShowNew(true)}>+ Новый агент</button>
            </div>
            {error && <div className="error-banner">{error}</div>}
            {loading && <div className="empty">Загрузка…</div>}
            {!loading && (
              <div className="ag-filters">
                <span className="ag-filter-label">Поиск:</span>
                <input className="ag-filter-input" placeholder="Имя или ID…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 160 }} />
                <span className="ag-filter-label">Шина:</span>
                <select className="ag-filter-select" value={filterBus} onChange={e => setFilterBus(e.target.value)}>
                  <option value="all">Все</option>
                  <option value="online">Онлайн</option>
                  <option value="offline">Офлайн</option>
                </select>
                <span className="ag-filter-label">Процесс:</span>
                <select className="ag-filter-select" value={filterLifecycle} onChange={e => setFilterLifecycle(e.target.value)}>
                  <option value="all">Все</option>
                  <option value="running">Запущен</option>
                  <option value="stopped">Остановлен</option>
                  <option value="error">Ошибка</option>
                  <option value="none">Нет процесса</option>
                </select>
                {allModels.length > 1 && <>
                  <span className="ag-filter-label">Модель:</span>
                  <select className="ag-filter-select" value={filterModel} onChange={e => setFilterModel(e.target.value)}>
                    <option value="all">Все</option>
                    {allModels.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </>}
                <span className="ag-filter-label">Сортировка:</span>
                <select className="ag-filter-select" value={sortBy} onChange={e => setSortBy(e.target.value as any)}>
                  <option value="name">По имени</option>
                  <option value="status">По статусу</option>
                  <option value="model">По модели</option>
                </select>
                {filteredAgents.length !== agents.length && (
                  <span style={{ fontSize: 12, color: '#6366f1', marginLeft: 4 }}>{filteredAgents.length} из {agents.length}</span>
                )}
              </div>
            )}
            {!loading && agents.length === 0 && <div className="empty">Агенты не зарегистрированы.</div>}
            {agents.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Агент</th>
                    <th>Шина</th>
                    <th>Процесс</th>
                    <th>Модель</th>
                    <th>Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAgents.map(a => {
                    const atype = getAgentType(a);
                    const isProtected = !!(a as any).protected;
                    const canEdit = atype === 'managed' || isProtected;
                    const displayName = a.name;
                    return (
                      <tr key={a.id}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            {(a as any).avatar_url
                              ? <img src={(a as any).avatar_url} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} />
                              : <div style={{ width: 36, height: 36, borderRadius: 6, background: isProtected ? '#0f172a' : '#6366f1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: 'white', fontWeight: 700, flexShrink: 0 }}>{displayName.charAt(0).toUpperCase()}</div>
                            }
                            <div>
                              <div style={{ fontWeight: 600 }}>
                                {displayName}
                                {isProtected
                                  ? <span className="badge-system">system</span>
                                  : <AgentTypeBadge type={atype} />
                                }
                              </div>
                              <div style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>
                                {a.display_alias ? `${a.display_alias} · ` : ''}{a.id}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className={`status-dot ${busColor(a.status)}`} />
                          {BUS_STATUS_LABELS[a.status] ?? a.status}
                        </td>
                        <td>
                          {a.lifecycle ? (
                            <>
                              <span className={`status-dot ${lifecycleColor(a.lifecycle)}`} />
                              {LIFECYCLE_STATUS_LABELS[a.lifecycle.status] ?? a.lifecycle.status}
                              {a.lifecycle.uptime_seconds ? (
                                <div className="uptime">{formatUptime(a.lifecycle.uptime_seconds)}</div>
                              ) : null}
                            </>
                          ) : '-'}
                        </td>
                        <td style={{ fontSize: 12, color: '#555' }}>
                          <div>{a.model || '-'}</div>
                          {a.runtime || a.reasoning_effort ? (
                            <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>
                              {a.runtime || 'auto'}{a.fallback_runtime ? ` → ${a.fallback_runtime}` : ''}
                              {a.reasoning_effort ? ` · ${a.reasoning_effort}` : ''}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <div className="actions">
                            {canEdit && a.lifecycle && <>
                              <button className="btn-start" onClick={() => action(a.id, () => api.agents.start(a.id), 'Start', isProtected)}>▶ Запустить</button>
                              <button className="btn-stop" onClick={() => action(a.id, () => api.agents.stop(a.id), 'Stop', isProtected)}>■ Остановить</button>
                              <button className="btn-restart" onClick={() => action(a.id, () => api.agents.restart(a.id), 'Restart', isProtected)}>↺</button>
                              <button onClick={() => setEditAgent(a)}>Изменить</button>
                            </>}
                            <button onClick={() => setTmuxAgent(a.id)}>Логи</button>
                            {canEdit && !isProtected && <button className="btn-del" onClick={() => action(a.id, () => api.agents.delete(a.id), 'Delete')}>🗑</button>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div className="refresh-info">Авто-обновление 10с • Последнее: {lastUpdate}</div>
          </div>
        </div>
      </div>
      {showNew && <NewAgentModal onClose={() => setShowNew(false)} onCreated={load} />}
      {tmuxAgent && <TmuxModal agentId={tmuxAgent} onClose={() => setTmuxAgent(null)} />}
      {editAgent && <EditAgentModal agent={editAgent} onClose={() => setEditAgent(null)} onSaved={load} />}
    </>
  );
}
