import type { WorkflowValidationIssue, WorkflowValidationReceipt } from '../api/types';

interface Props {
  receipt: WorkflowValidationReceipt | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onFocusElement: (id: string) => void;
}

function issueTarget(issue: WorkflowValidationIssue): string | null {
  if (issue.element_id) return issue.element_id;
  if (issue.edge) return issue.edge.join(' -> ');
  return null;
}

function issueTone(issue: WorkflowValidationIssue): 'error' | 'warning' {
  return issue.severity === 'warning' ? 'warning' : 'error';
}

export function workflowValidationCounts(receipt: WorkflowValidationReceipt | null) {
  return {
    errors: receipt?.errors.length ?? 0,
    warnings: receipt?.warnings.length ?? 0,
    blocked: receipt?.readiness === 'blocked',
  };
}

export function WorkflowDiagnosticsPanel({ receipt, loading, error, onRefresh, onFocusElement }: Props) {
  const issues = [...(receipt?.errors ?? []), ...(receipt?.warnings ?? [])];
  const counts = workflowValidationCounts(receipt);

  return (
    <section className={`workflow-diagnostics readiness-${receipt?.readiness ?? 'unknown'}`}>
      <div className="workflow-diagnostics-head">
        <div>
          <h3>Диагностика</h3>
          {receipt && (
            <div className="workflow-diagnostics-meta">
              {receipt.readiness} · ошибок: {counts.errors} · предупреждений: {counts.warnings}
            </div>
          )}
        </div>
        <button className="workflow-diagnostics-refresh" onClick={onRefresh} disabled={loading}>
          {loading ? '...' : 'Обновить'}
        </button>
      </div>

      {error && <div className="workflow-diagnostics-error">{error}</div>}

      {!error && !receipt && (
        <div className="workflow-diagnostics-empty">
          {loading ? 'Загрузка validation receipt...' : 'Процесс не выбран'}
        </div>
      )}

      {receipt && issues.length === 0 && (
        <div className="workflow-diagnostics-ok">Готово для deploy и case.start gates.</div>
      )}

      {issues.length > 0 && (
        <div className="workflow-diagnostics-list">
          {issues.map((issue, index) => {
            const target = issueTarget(issue);
            const canFocus = Boolean(issue.element_id);
            return (
              <button
                key={`${issue.code}-${issue.element_id ?? issue.edge?.join(':') ?? index}`}
                className={`workflow-diagnostic-item tone-${issueTone(issue)}`}
                onClick={() => { if (issue.element_id) onFocusElement(issue.element_id); }}
                disabled={!canFocus}
                title={target ?? issue.code}
              >
                <span className="workflow-diagnostic-main">
                  <span className="workflow-diagnostic-code">{issue.code}</span>
                  <span className="workflow-diagnostic-class">{issue.class}</span>
                </span>
                <span className="workflow-diagnostic-message">{issue.message}</span>
                {target && <span className="workflow-diagnostic-target">{target}</span>}
              </button>
            );
          })}
        </div>
      )}

      {receipt && (
        <div className="workflow-diagnostics-gates">
          <span className={receipt.gates.deployment_blocker ? 'gate-blocked' : 'gate-clear'}>deploy</span>
          <span className={receipt.gates.case_start_blocker ? 'gate-blocked' : 'gate-clear'}>case.start</span>
          <span className={receipt.gates.reviewer_required ? 'gate-review' : 'gate-clear'}>review</span>
        </div>
      )}
    </section>
  );
}
