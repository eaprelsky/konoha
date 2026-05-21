import { fireEvent, render, screen } from '@testing-library/react';
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
});
