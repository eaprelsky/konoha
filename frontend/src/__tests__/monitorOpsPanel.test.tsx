import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { EventWait, RuntimeEffectRecord, Run } from '../api/types';
import { actionableEffects, actionableWaits, MonitorOpsPanel } from '../pages/MonitorOpsPanel';

const labels: Record<string, string> = {
  'operator.monitor.opsTitle': 'Recovery monitor',
  'operator.monitor.opsSubtitle': '{effects} effect(s), {waits} wait(s)',
  'operator.monitor.failedEffects': 'Failed effects',
  'operator.monitor.noFailedEffects': 'No failed effects',
  'operator.monitor.waitingStates': 'Waiting states',
  'operator.monitor.noWaitingStates': 'No waiting states',
  'operator.monitor.retryEffect': 'Retry',
  'operator.monitor.deadLetterEffect': 'Dead-letter',
  'operator.monitor.attempts': '{count} attempts',
  'label.deadline': 'Deadline',
};

function t(key: string): string {
  return labels[key] ?? key;
}

function effect(patch: Partial<RuntimeEffectRecord>): RuntimeEffectRecord {
  return {
    schema_version: 1,
    effect_id: 'rte-1',
    kind: 'workitem.dispatch',
    payload: {},
    idempotency_key: 'idem-1',
    status: 'retry',
    attempts: 1,
    retry_policy: {
      max_attempts: 5,
      backoff: 'exponential',
      retry_delays_ms: [1000],
      dead_letter_after_attempts: 5,
    },
    links: { case_id: 'case-1', work_item_id: 'wi-1' },
    created_at: '2026-05-22T00:00:00.000Z',
    updated_at: '2026-05-22T00:01:00.000Z',
    error: {
      code: 'WORKITEM_DISPATCH_UNAVAILABLE',
      message: 'dispatch unavailable',
      retryable: true,
      failed_at: '2026-05-22T00:01:00.000Z',
    },
    ...patch,
  };
}

function wait(patch: Partial<EventWait>): EventWait {
  return {
    wait_id: 'wait-1',
    case_id: 'case-1',
    process_id: 'workflow-1',
    element_id: 'approval',
    element_label: 'Approval',
    trigger_kind: 'manual',
    status: 'active',
    created_at: '2026-05-22T00:00:00.000Z',
    assignee: 'operator',
    ...patch,
  };
}

const run: Run = {
  case_id: 'case-1',
  process_id: 'workflow-1',
  process_version: '1.0.0',
  subject: 'Customer approval',
  status: 'running',
  payload: {},
  history: [],
  created_at: '2026-05-22T00:00:00.000Z',
};

describe('MonitorOpsPanel', () => {
  test('prioritizes dead-letter effects and escalated waits for operator recovery', () => {
    expect(actionableEffects([
      effect({ effect_id: 'retry', status: 'retry' }),
      effect({ effect_id: 'dead', status: 'dead_letter' }),
      effect({ effect_id: 'ok', status: 'succeeded' }),
    ]).map(item => item.effect_id)).toEqual(['dead', 'retry']);

    expect(actionableWaits([
      wait({ wait_id: 'active', status: 'active' }),
      wait({ wait_id: 'escalated', status: 'escalated' }),
      wait({ wait_id: 'fired', status: 'fired' }),
    ]).map(item => item.wait_id)).toEqual(['escalated', 'active']);
  });

  test('renders failed effects, waiting states, and recovery actions', () => {
    const onRecoverEffect = vi.fn();
    const onSelectCase = vi.fn();

    render(
      <MonitorOpsPanel
        effects={[effect({ status: 'dead_letter', attempts: 5 })]}
        effectSummary={{ total: 1, pending: 0, in_flight: 0, retry: 0, failed: 0, dead_letter: 1, cancelled: 0, succeeded: 0, recovery_actionable: 1 }}
        waits={[wait({ status: 'overdue', deadline: '2026-05-22T01:00:00.000Z' })]}
        runsById={new Map([[run.case_id, run]])}
        processNames={{ 'workflow-1': 'Approval workflow' }}
        onRecoverEffect={onRecoverEffect}
        onSelectCase={onSelectCase}
        t={t}
      />,
    );

    expect(screen.getByText('Failed effects')).toBeInTheDocument();
    expect(screen.getByText('WORKITEM_DISPATCH_UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByText('Waiting states')).toBeInTheDocument();
    expect(screen.getByText('Approval')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Retry'));
    expect(onRecoverEffect).toHaveBeenCalledWith(expect.objectContaining({ effect_id: 'rte-1' }), 'retry');

    fireEvent.click(screen.getAllByText('Customer approval')[1]);
    expect(onSelectCase).toHaveBeenCalledWith('case-1');
  });
});
