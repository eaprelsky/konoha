import { describe, expect, test, beforeEach } from 'vitest';
import type { RoleDef, Run, RuntimeEvent, Workflow } from '../api/types';
import {
  filterOperatorCases,
  filterOperatorEvents,
  filterOperatorRoles,
  filterOperatorRuns,
  filterOperatorWaits,
  filterOperatorWorkItems,
  filterOperatorWorkflows,
  readShowHiddenArtifacts,
} from '../utils/operatorView';

const baseWorkflow: Workflow = {
  id: 'sales-lead',
  name: 'Sales Lead',
  version: '1.0.0',
  elements: [],
  flow: [],
};

const baseRole: RoleDef = {
  role_id: 'sales_owner',
  name: 'Sales owner',
  assignees: [],
  strategy: 'manual',
  created_at: '',
  updated_at: '',
};

const baseRun: Run = {
  case_id: 'case-1',
  process_id: 'sales-lead',
  process_version: '1.0.0',
  subject: 'Lead from Telegram',
  status: 'running',
  payload: {},
  history: [],
  created_at: '2026-04-30T00:00:00.000Z',
};

describe('operatorView filtering', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/ui/editor');
    window.localStorage.clear();
  });

  test('keeps operator workflows and hides explicit debug/test metadata', () => {
    const workflows: Workflow[] = [
      baseWorkflow,
      { ...baseWorkflow, id: 'debug-flow', metadata: { visibility: 'debug' } },
      { ...baseWorkflow, id: 'generated-flow', metadata: { source: 'testbench' } },
    ];

    expect(filterOperatorWorkflows(workflows).map(w => w.id)).toEqual(['sales-lead']);
    expect(filterOperatorWorkflows(workflows, { showHiddenArtifacts: true })).toHaveLength(3);
  });

  test('hides legacy untagged test workflows by stable generated ids', () => {
    const workflows: Workflow[] = [
      baseWorkflow,
      { ...baseWorkflow, id: 'e2e-mobile-428-1775845206681', name: 'Mobile Editor Test' },
      { ...baseWorkflow, id: 'tc-b03-connector-462', name: 'TC connector' },
      { ...baseWorkflow, id: 'process-mnnaqaey-copy', name: 'Мониторинг состояния очереди (копия)' },
      { ...baseWorkflow, id: 'a76fcb10-e047-46bf-aee8-e3467bd50cdc', name: 'Draft 2026-04-10 23:15' },
    ];

    expect(filterOperatorWorkflows(workflows).map(w => w.id)).toEqual(['sales-lead']);
  });

  test('filters runs through explicit payload metadata and hidden workflow ids', () => {
    const hiddenProcesses = new Set(['process-mnnaqaey-copy']);
    const runs: Run[] = [
      baseRun,
      { ...baseRun, case_id: 'case-2', process_id: 'process-mnnaqaey-copy' },
      { ...baseRun, case_id: 'case-3', payload: { metadata: { visibility: 'test' } } },
    ];

    expect(filterOperatorRuns(runs, hiddenProcesses).map(run => run.case_id)).toEqual(['case-1']);
  });

  test('filters legacy cases with the same operator rules as runs', () => {
    const hiddenProcesses = new Set(['process-mnnaqaey-copy']);
    const cases: Run[] = [
      baseRun,
      { ...baseRun, case_id: 'case-2', process_id: 'process-mnnaqaey-copy' },
      { ...baseRun, case_id: 'case-3', payload: { metadata: { visibility: 'test' } } },
    ];

    expect(filterOperatorCases(cases, hiddenProcesses).map(kase => kase.case_id)).toEqual(['case-1']);
  });

  test('filters test roles while preserving business roles', () => {
    const roles: RoleDef[] = [
      baseRole,
      { ...baseRole, role_id: 'tester', name: 'tester' },
      { ...baseRole, role_id: 'debug-role', metadata: { lifecycle: 'deprecated' } },
    ];

    expect(filterOperatorRoles(roles).map(role => role.role_id)).toEqual(['sales_owner']);
  });

  test('filters events for hidden workflows', () => {
    const events: RuntimeEvent[] = [
      { type: 'case.created', process_id: 'sales-lead', timestamp: '' },
      { type: 'case.created', process_id: 'e2e-flow', timestamp: '' },
      { type: 'test.noise', timestamp: '' },
    ];

    expect(filterOperatorEvents(events, new Set(['e2e-flow'])).map(event => event.type)).toEqual(['case.created']);
  });

  test('filters operator task queues by hidden workflow ids', () => {
    const hiddenProcesses = new Set(['process-mnnaqaey-copy']);
    const workItems = [
      { work_item_id: 'wi-1', case_id: 'case-1', process_id: 'sales-lead', element_id: 'fn-1', label: 'Visible task', assignee: 'operator', status: 'pending', input: {}, created_at: '', updated_at: '' },
      { work_item_id: 'wi-2', case_id: 'case-2', process_id: 'process-mnnaqaey-copy', element_id: 'fn-1', label: 'Hidden task', assignee: 'operator', status: 'pending', input: {}, created_at: '', updated_at: '' },
    ];
    const waits = [
      { wait_id: 'wait-1', case_id: 'case-1', process_id: 'sales-lead', element_id: 'wait', trigger_kind: 'manual', status: 'active', created_at: '' },
      { wait_id: 'wait-2', case_id: 'case-2', process_id: 'process-mnnaqaey-copy', element_id: 'wait', trigger_kind: 'manual', status: 'active', created_at: '' },
    ];

    expect(filterOperatorWorkItems(workItems as any, hiddenProcesses).map(item => item.work_item_id)).toEqual(['wi-1']);
    expect(filterOperatorWaits(waits as any, hiddenProcesses).map(wait => wait.wait_id)).toEqual(['wait-1']);
  });

  test('supports debug view from url or local storage', () => {
    window.localStorage.setItem('konoha.operatorView.showHiddenArtifacts', 'true');
    expect(readShowHiddenArtifacts()).toBe(true);

    window.history.replaceState({}, '', '/ui/editor?view=operator');
    expect(readShowHiddenArtifacts()).toBe(false);

    window.history.replaceState({}, '', '/ui/editor?view=debug');
    expect(readShowHiddenArtifacts()).toBe(true);
  });
});
