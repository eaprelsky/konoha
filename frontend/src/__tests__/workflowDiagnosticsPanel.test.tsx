import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { WorkflowValidationReceipt } from '../api/types';
import { WorkflowDiagnosticsPanel, workflowValidationCounts } from '../pages/WorkflowDiagnosticsPanel';

const blockedReceipt: WorkflowValidationReceipt = {
  workflow_id: 'wf-1',
  taxonomy_version: 1,
  readiness: 'blocked',
  source: 'workflow.deploy',
  checked_at: '2026-05-21T00:00:00.000Z',
  errors: [
    {
      code: 'ADAPTER_MISSING',
      severity: 'error',
      class: 'adapter',
      message: 'Function "task" references missing adapter "crm"',
      element_id: 'task',
      details: { connector: 'crm' },
    },
  ],
  warnings: [
    {
      code: 'MIGRATION_RUNNING_CASES_PRESENT',
      severity: 'warning',
      class: 'migration',
      message: 'Workflow has running cases',
    },
  ],
  gates: {
    deployment_blocker: true,
    case_start_blocker: true,
    release_blocker: true,
    reviewer_required: true,
  },
};

describe('WorkflowDiagnosticsPanel', () => {
  test('renders stable validation code/class and focuses affected element', () => {
    const onFocusElement = vi.fn();

    render(
      <WorkflowDiagnosticsPanel
        receipt={blockedReceipt}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
        onFocusElement={onFocusElement}
      />,
    );

    expect(screen.getByText('ADAPTER_MISSING')).toBeInTheDocument();
    expect(screen.getByText('adapter')).toBeInTheDocument();
    expect(screen.getByText('task')).toBeInTheDocument();
    expect(screen.getByText('MIGRATION_RUNNING_CASES_PRESENT')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /ADAPTER_MISSING/i }));

    expect(onFocusElement).toHaveBeenCalledWith('task');
  });

  test('summarizes readiness counts without parsing messages', () => {
    expect(workflowValidationCounts(blockedReceipt)).toEqual({
      errors: 1,
      warnings: 1,
      blocked: true,
    });
  });

  test('renders role assignment actions from stable role validation codes', async () => {
    const onResolveRoleIssue = vi.fn().mockResolvedValue(undefined);
    const roleReceipt: WorkflowValidationReceipt = {
      ...blockedReceipt,
      errors: [
        {
          code: 'ROLE_UNRESOLVABLE',
          severity: 'error',
          class: 'role',
          message: 'Function "review" role "sales_owner" cannot resolve',
          element_id: 'review',
          details: { role: 'sales_owner' },
        },
      ],
      warnings: [],
    };

    render(
      <WorkflowDiagnosticsPanel
        receipt={roleReceipt}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
        onFocusElement={vi.fn()}
        roles={[]}
        agents={[{ id: 'sasuke', name: 'Sasuke', status: 'online' } as any]}
        people={[{ id: 'person-1', name: 'Yegor', tg_id: 123, position: 'owner' } as any]}
        onResolveRoleIssue={onResolveRoleIssue}
      />,
    );

    expect(screen.getByText('ROLE_UNRESOLVABLE')).toBeInTheDocument();
    expect(screen.getByText('sales_owner')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Assignee for sales_owner'), { target: { value: 'sasuke' } });
    fireEvent.click(screen.getByRole('button', { name: /Assign/i }));

    await waitFor(() => expect(onResolveRoleIssue).toHaveBeenCalledWith(
      roleReceipt.errors[0],
      { mode: 'assign', assignee: 'sasuke' },
    ));
    expect(await screen.findByText('Assignee saved')).toBeInTheDocument();
  });

  test('allows explicit manual queue resolution for missing assignee role errors', async () => {
    const onResolveRoleIssue = vi.fn().mockResolvedValue(undefined);
    const roleReceipt: WorkflowValidationReceipt = {
      ...blockedReceipt,
      errors: [
        {
          code: 'ROLE_MISSING_ASSIGNEE',
          severity: 'error',
          class: 'role',
          message: 'Role "reviewer" has no assignees and is not manual',
          element_id: 'review',
          details: { role: 'reviewer', strategy: 'round-robin' },
        },
      ],
      warnings: [],
    };

    render(
      <WorkflowDiagnosticsPanel
        receipt={roleReceipt}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
        onFocusElement={vi.fn()}
        roles={[{ role_id: 'reviewer', name: 'Reviewer', assignees: [], strategy: 'round-robin', created_at: '', updated_at: '' }]}
        agents={[]}
        people={[]}
        onResolveRoleIssue={onResolveRoleIssue}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Manual$/i }));

    await waitFor(() => expect(onResolveRoleIssue).toHaveBeenCalledWith(
      roleReceipt.errors[0],
      { mode: 'manual' },
    ));
    expect(await screen.findByText('Manual queue saved')).toBeInTheDocument();
  });
});
