import { useEffect, useMemo, useState } from 'react';
import { Inbox, Loader2, UserCheck } from 'lucide-react';
import type { Agent, Person, RoleDef, WorkflowValidationIssue, WorkflowValidationReceipt } from '../api/types';
import {
  buildRoleAssigneeOptions,
  extractRoleAssignmentIssue,
  type RoleAssignmentResolution,
} from './roleAssignmentResolution';

interface Props {
  receipt: WorkflowValidationReceipt | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onFocusElement: (id: string) => void;
  roles?: RoleDef[];
  agents?: Agent[];
  people?: Person[];
  onResolveRoleIssue?: (issue: WorkflowValidationIssue, resolution: RoleAssignmentResolution) => Promise<void>;
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

interface RoleAssignmentControlsProps {
  issue: WorkflowValidationIssue;
  roles: RoleDef[];
  agents: Agent[];
  people: Person[];
  onResolveRoleIssue?: (issue: WorkflowValidationIssue, resolution: RoleAssignmentResolution) => Promise<void>;
}

function WorkflowRoleAssignmentControls({ issue, roles, agents, people, onResolveRoleIssue }: RoleAssignmentControlsProps) {
  const roleIssue = extractRoleAssignmentIssue(issue);
  const options = useMemo(() => buildRoleAssigneeOptions(agents, people), [agents, people]);
  const currentRole = roleIssue ? roles.find(role => role.role_id === roleIssue.role) : undefined;
  const [assignee, setAssignee] = useState(options[0]?.id ?? '');
  const [busy, setBusy] = useState<'assign' | 'manual' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!assignee && options[0]) setAssignee(options[0].id);
  }, [assignee, options]);

  if (!roleIssue || !onResolveRoleIssue) return null;

  async function apply(resolution: RoleAssignmentResolution, mode: 'assign' | 'manual') {
    setBusy(mode);
    setMessage(null);
    setFailure(null);
    try {
      await onResolveRoleIssue(issue, resolution);
      setMessage(mode === 'manual' ? 'Manual queue saved' : 'Assignee saved');
    } catch (err: any) {
      setFailure(err?.message ?? 'Role update failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="workflow-role-resolution" onClick={event => event.stopPropagation()}>
      <div className="workflow-role-resolution-title">
        <span>Role</span>
        <code>{roleIssue.role}</code>
        {currentRole && <span className="workflow-role-resolution-state">{currentRole.strategy}</span>}
      </div>
      <div className="workflow-role-resolution-row">
        <select
          aria-label={`Assignee for ${roleIssue.role}`}
          value={assignee}
          onChange={event => setAssignee(event.target.value)}
          disabled={busy !== null || options.length === 0}
        >
          {options.length === 0 && <option value="">No reachable assignees</option>}
          {options.map(option => (
            <option key={`${option.group}:${option.id}`} value={option.id}>
              {option.group === 'agents' ? 'Agent' : 'Person'} · {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="workflow-role-resolution-action"
          disabled={busy !== null || !assignee}
          onClick={() => apply({ mode: 'assign', assignee }, 'assign')}
        >
          {busy === 'assign' ? <Loader2 size={12} aria-hidden="true" /> : <UserCheck size={12} aria-hidden="true" />}
          Assign
        </button>
        <button
          type="button"
          className="workflow-role-resolution-action secondary"
          disabled={busy !== null}
          onClick={() => apply({ mode: 'manual' }, 'manual')}
        >
          {busy === 'manual' ? <Loader2 size={12} aria-hidden="true" /> : <Inbox size={12} aria-hidden="true" />}
          Manual
        </button>
      </div>
      {roleIssue.current_assignees.length > 0 && (
        <div className="workflow-role-resolution-current">
          Current: {roleIssue.current_assignees.join(', ')}
        </div>
      )}
      {message && <div className="workflow-role-resolution-ok">{message}</div>}
      {failure && <div className="workflow-role-resolution-error">{failure}</div>}
    </div>
  );
}

export function WorkflowDiagnosticsPanel({
  receipt,
  loading,
  error,
  onRefresh,
  onFocusElement,
  roles = [],
  agents = [],
  people = [],
  onResolveRoleIssue,
}: Props) {
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
              <div
                key={`${issue.code}-${issue.element_id ?? issue.edge?.join(':') ?? index}`}
                className={`workflow-diagnostic-item tone-${issueTone(issue)}`}
                title={target ?? issue.code}
              >
                <button
                  type="button"
                  className="workflow-diagnostic-focus"
                  onClick={() => { if (issue.element_id) onFocusElement(issue.element_id); }}
                  disabled={!canFocus}
                >
                  <span className="workflow-diagnostic-main">
                    <span className="workflow-diagnostic-code">{issue.code}</span>
                    <span className="workflow-diagnostic-class">{issue.class}</span>
                  </span>
                  <span className="workflow-diagnostic-message">{issue.message}</span>
                  {target && <span className="workflow-diagnostic-target">{target}</span>}
                </button>
                <WorkflowRoleAssignmentControls
                  issue={issue}
                  roles={roles}
                  agents={agents}
                  people={people}
                  onResolveRoleIssue={onResolveRoleIssue}
                />
              </div>
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
