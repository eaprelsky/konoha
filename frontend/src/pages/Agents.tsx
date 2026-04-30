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
import type { AgentLifecycleClassFilter } from '../hooks/useAgentFilters';
import { busColor, lifecycleColor, formatUptime, getAgentType } from '../components/agents/agentUtils';
import { agentDisplayName } from '../utils/agentDisplay';
import { useI18n } from '../context/I18nContext';

export function Agents() {
  const { agents, loading, error: loadError, lastUpdate, load } = useAgents();
  const { t } = useI18n();
  const { search, setSearch, filterBus, setFilterBus, filterLifecycle, setFilterLifecycle, filterClass, setFilterClass, filterModel, setFilterModel, sortBy, setSortBy, filteredAgents, allModels } = useAgentFilters(agents);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [tmuxAgent, setTmuxAgent] = useState<string | null>(null);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);

  const error = loadError || actionError;

  async function action(id: string, fn: () => Promise<unknown>, label: string, isProtected?: boolean) {
    if (label === 'Delete') {
      if (isProtected) { setActionError(t('agent.page.protectedDeleteError', 'Agent "{id}" is protected and cannot be deleted.').replace('{id}', id)); return; }
      if (!confirm(t('agent.page.confirmDelete', 'Delete agent "{id}"? This action cannot be undone.').replace('{id}', id))) return;
    }
    if ((label === 'Start' || label === 'Stop' || label === 'Restart') && isProtected) {
      if (!confirm(t('agent.page.confirmProtectedLifecycle', 'Agent "{id}" is protected. Lifecycle is managed through konoha.service / systemd.\nContinue?').replace('{id}', id))) return;
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
              <h1>{t('page.agents.title', 'Agents')}</h1>
              <button className="btn-new" onClick={() => setShowNew(true)}>{t('page.agents.new', '+ New Agent')}</button>
            </div>
            {error && <div className="error-banner">{error}</div>}
            {loading && <div className="empty">{t('status.loading', 'Loading...')}</div>}
            {!loading && (
              <div className="ag-filters">
                <span className="ag-filter-label">{t('agent.page.search', 'Search')}:</span>
                <input className="ag-filter-input" placeholder={t('agent.page.searchPlaceholder', 'Name or ID...')} value={search} onChange={e => setSearch(e.target.value)} style={{ width: 160 }} />
                <span className="ag-filter-label">{t('agent.page.bus', 'Bus')}:</span>
                <select className="ag-filter-select" value={filterBus} onChange={e => setFilterBus(e.target.value)}>
                  <option value="all">{t('filter.all', 'All')}</option>
                  <option value="online">{t('status.online', 'Online')}</option>
                  <option value="offline">{t('status.offline', 'Offline')}</option>
                </select>
                <span className="ag-filter-label">{t('agent.page.class', 'Class')}:</span>
                <select className="ag-filter-select" value={filterClass} onChange={e => setFilterClass(e.target.value as AgentLifecycleClassFilter)}>
                  <option value="all">{t('filter.all', 'All')}</option>
                  <option value="core">{t('agent.type.core', 'Core')}</option>
                  <option value="connector">{t('agent.type.connectorPlural', 'Connectors')}</option>
                  <option value="optional">{t('agent.type.optionalPlural', 'Optional workers')}</option>
                  <option value="deprecated">{t('agent.type.deprecated', 'Compatibility')}</option>
                  <option value="external">{t('agent.type.externalPlural', 'External')}</option>
                  <option value="managed">{t('agent.type.managedPlural', 'Managed')}</option>
                </select>
                <span className="ag-filter-label">{t('label.process', 'Process')}:</span>
                <select className="ag-filter-select" value={filterLifecycle} onChange={e => setFilterLifecycle(e.target.value)}>
                  <option value="all">{t('filter.all', 'All')}</option>
                  <option value="running">{t('status.running', 'Running')}</option>
                  <option value="stopped">{t('status.stopped', 'Stopped')}</option>
                  <option value="error">{t('status.error', 'Error')}</option>
                  <option value="none">{t('agent.page.noProcess', 'No process')}</option>
                </select>
                {allModels.length > 1 && <>
                  <span className="ag-filter-label">{t('label.model', 'Model')}:</span>
                  <select className="ag-filter-select" value={filterModel} onChange={e => setFilterModel(e.target.value)}>
                    <option value="all">{t('filter.all', 'All')}</option>
                    {allModels.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </>}
                <span className="ag-filter-label">{t('agent.page.sort', 'Sort')}:</span>
                <select className="ag-filter-select" value={sortBy} onChange={e => setSortBy(e.target.value as any)}>
                  <option value="name">{t('agent.page.sortByName', 'By name')}</option>
                  <option value="status">{t('agent.page.sortByStatus', 'By status')}</option>
                  <option value="model">{t('agent.page.sortByModel', 'By model')}</option>
                </select>
                {filteredAgents.length !== agents.length && (
                  <span style={{ fontSize: 12, color: '#6366f1', marginLeft: 4 }}>{t('agent.page.filteredCount', '{shown} of {total}').replace('{shown}', String(filteredAgents.length)).replace('{total}', String(agents.length))}</span>
                )}
                <div className="ag-filter-help">{t('agent.page.filterHelp', 'Optional workers are started by assignment or policy; deprecated actors are kept only for compatibility.')}</div>
              </div>
            )}
            {!loading && agents.length === 0 && <div className="empty">{t('empty.agents', 'No agents registered.')}</div>}
            {agents.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('agent.page.agent', 'Agent')}</th>
                    <th>{t('agent.page.bus', 'Bus')}</th>
                    <th>{t('label.process', 'Process')}</th>
                    <th>{t('label.model', 'Model')}</th>
                    <th>{t('label.actions', 'Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAgents.map(a => {
                    const atype = getAgentType(a);
                    const isProtected = !!(a as any).protected;
                    const canEdit = atype === 'managed' || isProtected;
                    const displayName = agentDisplayName(a);
                    return (
                      <tr key={a.id} className={atype === 'deprecated' ? 'agent-row-deprecated' : undefined}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            {(a as any).avatar_url
                              ? <img src={(a as any).avatar_url} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} />
                              : <div style={{ width: 36, height: 36, borderRadius: 6, background: isProtected ? '#0f172a' : '#6366f1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: 'white', fontWeight: 700, flexShrink: 0 }}>{displayName.charAt(0).toUpperCase()}</div>
                            }
                            <div>
                              <div style={{ fontWeight: 600 }}>
                                {displayName}
                                <AgentTypeBadge type={atype} />
                              </div>
                              <div style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>
                                {(a.display?.alias || a.display_alias) ? `${a.display?.alias || a.display_alias} · ` : ''}{a.id}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className={`status-dot ${busColor(a.status)}`} />
                          {t(`status.${a.status}`, a.status)}
                        </td>
                        <td>
                          {a.lifecycle ? (
                            <>
                              <span className={`status-dot ${lifecycleColor(a.lifecycle)}`} />
                              {t(`status.${a.lifecycle.status}`, a.lifecycle.status)}
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
                              <button className="btn-start" onClick={() => action(a.id, () => api.agents.start(a.id), 'Start', isProtected)}>▶ {t('agent.page.start', 'Start')}</button>
                              <button className="btn-stop" onClick={() => action(a.id, () => api.agents.stop(a.id), 'Stop', isProtected)}>■ {t('agent.page.stop', 'Stop')}</button>
                              <button className="btn-restart" onClick={() => action(a.id, () => api.agents.restart(a.id), 'Restart', isProtected)}>↺</button>
                              <button onClick={() => setEditAgent(a)}>{t('action.edit', 'Edit')}</button>
                            </>}
                            <button onClick={() => setTmuxAgent(a.id)}>{t('agent.page.logs', 'Logs')}</button>
                            {canEdit && !isProtected && <button className="btn-del" onClick={() => action(a.id, () => api.agents.delete(a.id), 'Delete')}>🗑</button>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div className="refresh-info">{t('agent.page.refresh', 'Auto-refresh 10s - Last: {time}').replace('{time}', lastUpdate)}</div>
          </div>
        </div>
      </div>
      {showNew && <NewAgentModal onClose={() => setShowNew(false)} onCreated={load} />}
      {tmuxAgent && <TmuxModal agentId={tmuxAgent} onClose={() => setTmuxAgent(null)} />}
      {editAgent && <EditAgentModal agent={editAgent} onClose={() => setEditAgent(null)} onSaved={load} />}
    </>
  );
}
