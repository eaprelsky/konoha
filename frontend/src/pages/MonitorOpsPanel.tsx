import type { EventWait, RuntimeEffectRecord, RuntimeEffectsSummary, Run } from '../api/types';

export type MonitorRecoveryAction = 'retry' | 'dead_letter';

export interface MonitorOpsPanelProps {
  effects: RuntimeEffectRecord[];
  effectSummary?: RuntimeEffectsSummary | null;
  waits: EventWait[];
  runsById: Map<string, Run>;
  processNames: Record<string, string>;
  loading?: boolean;
  error?: string | null;
  actionBusyId?: string | null;
  onRecoverEffect: (effect: RuntimeEffectRecord, action: MonitorRecoveryAction) => void | Promise<void>;
  onSelectCase: (caseId: string) => void;
  t: (key: string) => string;
}

function fmtTime(iso?: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export function actionableEffects(effects: RuntimeEffectRecord[]): RuntimeEffectRecord[] {
  return effects
    .filter(effect => effect.status === 'retry' || effect.status === 'failed' || effect.status === 'dead_letter')
    .sort((a, b) => {
      const rank: Record<string, number> = { dead_letter: 0, failed: 1, retry: 2 };
      const byRank = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
      if (byRank !== 0) return byRank;
      return a.updated_at.localeCompare(b.updated_at);
    });
}

export function actionableWaits(waits: EventWait[]): EventWait[] {
  return waits
    .filter(wait => wait.status === 'active' || wait.status === 'overdue' || wait.status === 'escalated')
    .sort((a, b) => {
      const rank: Record<string, number> = { escalated: 0, overdue: 1, active: 2 };
      const byRank = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
      if (byRank !== 0) return byRank;
      const aDeadline = a.deadline ? Date.parse(a.deadline) : Number.MAX_SAFE_INTEGER;
      const bDeadline = b.deadline ? Date.parse(b.deadline) : Number.MAX_SAFE_INTEGER;
      if (aDeadline !== bDeadline) return aDeadline - bDeadline;
      return a.created_at.localeCompare(b.created_at);
    });
}

function effectStatusClass(effect: RuntimeEffectRecord): string {
  if (effect.status === 'dead_letter') return 'critical';
  if (effect.status === 'failed') return 'bad';
  return 'warn';
}

function waitStatusClass(wait: EventWait): string {
  if (wait.status === 'escalated') return 'critical';
  if (wait.status === 'overdue') return 'bad';
  return 'warn';
}

export function MonitorOpsPanel({
  effects,
  effectSummary,
  waits,
  runsById,
  processNames,
  loading = false,
  error = null,
  actionBusyId = null,
  onRecoverEffect,
  onSelectCase,
  t,
}: MonitorOpsPanelProps) {
  const visibleEffects = actionableEffects(effects).slice(0, 6);
  const visibleWaits = actionableWaits(waits).slice(0, 6);
  const totalEffects = effectSummary?.recovery_actionable ?? visibleEffects.length;

  return (
    <section className="mon-ops" aria-label={t('operator.monitor.opsTitle')}>
      <div className="mon-ops-head">
        <div>
          <div className="mon-ops-title">{t('operator.monitor.opsTitle')}</div>
          <div className="mon-ops-subtitle">
            {t('operator.monitor.opsSubtitle')
              .replace('{effects}', String(totalEffects))
              .replace('{waits}', String(visibleWaits.length))}
          </div>
        </div>
        {loading && <span className="mon-ops-loading">{t('status.loading')}</span>}
      </div>

      {error && <div className="mon-ops-error">{error}</div>}

      <div className="mon-ops-grid">
        <div className="mon-ops-column">
          <div className="mon-ops-column-head">
            <span>{t('operator.monitor.failedEffects')}</span>
            <b>{visibleEffects.length}</b>
          </div>
          {visibleEffects.length === 0 ? (
            <div className="mon-ops-empty">{t('operator.monitor.noFailedEffects')}</div>
          ) : visibleEffects.map(effect => {
            const caseId = effect.links.case_id;
            const run = caseId ? runsById.get(caseId) : undefined;
            return (
              <div className="mon-ops-item" key={effect.effect_id}>
                <div className="mon-ops-row">
                  <span className={`mon-ops-badge ${effectStatusClass(effect)}`}>{effect.status}</span>
                  <span className="mon-ops-name">{effect.kind}</span>
                </div>
                <div className="mon-ops-meta">
                  <span>{effect.error?.code ?? effect.receipt?.status ?? effect.effect_id}</span>
                  <span>{t('operator.monitor.attempts').replace('{count}', String(effect.attempts))}</span>
                  <span>{fmtTime(effect.updated_at)}</span>
                </div>
                {caseId && (
                  <button className="mon-ops-link" type="button" onClick={() => onSelectCase(caseId)}>
                    {run?.subject || caseId}
                  </button>
                )}
                <div className="mon-ops-actions">
                  <button
                    type="button"
                    disabled={actionBusyId === effect.effect_id}
                    onClick={() => onRecoverEffect(effect, 'retry')}
                  >
                    {t('operator.monitor.retryEffect')}
                  </button>
                  {effect.status !== 'dead_letter' && (
                    <button
                      type="button"
                      disabled={actionBusyId === effect.effect_id}
                      onClick={() => onRecoverEffect(effect, 'dead_letter')}
                    >
                      {t('operator.monitor.deadLetterEffect')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mon-ops-column">
          <div className="mon-ops-column-head">
            <span>{t('operator.monitor.waitingStates')}</span>
            <b>{visibleWaits.length}</b>
          </div>
          {visibleWaits.length === 0 ? (
            <div className="mon-ops-empty">{t('operator.monitor.noWaitingStates')}</div>
          ) : visibleWaits.map(wait => {
            const run = runsById.get(wait.case_id);
            return (
              <button
                className="mon-ops-item mon-ops-wait"
                key={wait.wait_id}
                type="button"
                onClick={() => onSelectCase(wait.case_id)}
              >
                <div className="mon-ops-row">
                  <span className={`mon-ops-badge ${waitStatusClass(wait)}`}>{wait.status}</span>
                  <span className="mon-ops-name">{wait.element_label || wait.element_id}</span>
                </div>
                <div className="mon-ops-meta">
                  <span>{processNames[wait.process_id] || wait.process_id}</span>
                  <span>{wait.trigger_kind}</span>
                  {wait.assignee && <span>{wait.assignee}</span>}
                </div>
                <div className="mon-ops-case">{run?.subject || wait.case_id}</div>
                {wait.deadline && <div className="mon-ops-deadline">{t('label.deadline')}: {fmtTime(wait.deadline)}</div>}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
