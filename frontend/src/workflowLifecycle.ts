import type { Workflow } from './api/types';

export type WorkflowLifecycleState = NonNullable<Workflow['lifecycle_state']>;

const CANONICAL_STATES: WorkflowLifecycleState[] = ['draft', 'validated', 'deployed', 'executable', 'retired'];
const CANONICAL_STATE_SET = new Set<string>(CANONICAL_STATES);

export interface WorkflowLifecycleView {
  state: WorkflowLifecycleState;
  label: string;
  tone: 'neutral' | 'warning' | 'success' | 'danger';
  canStartCase: boolean;
  runTitle: string;
  runBlockedReason?: string;
}

export function canonicalWorkflowLifecycleState(workflow: Pick<Workflow, 'lifecycle_state' | 'status'> | null | undefined): WorkflowLifecycleState {
  if (workflow?.lifecycle_state && CANONICAL_STATE_SET.has(workflow.lifecycle_state)) return workflow.lifecycle_state;
  if (typeof workflow?.status === 'string' && CANONICAL_STATE_SET.has(workflow.status)) {
    return workflow.status as WorkflowLifecycleState;
  }
  return 'draft';
}

export function workflowLifecycleView(workflow: Pick<Workflow, 'lifecycle_state' | 'status'> | null | undefined): WorkflowLifecycleView {
  const state = canonicalWorkflowLifecycleState(workflow);
  switch (state) {
    case 'executable':
      return {
        state,
        label: 'executable',
        tone: 'success',
        canStartCase: true,
        runTitle: 'Процесс исполняемый: можно запустить новый прогон',
      };
    case 'retired':
      return {
        state,
        label: 'retired',
        tone: 'danger',
        canStartCase: false,
        runTitle: 'Процесс retired: новые прогоны запрещены backend gate',
        runBlockedReason: 'WORKFLOW_NOT_EXECUTABLE: retired workflows cannot start new cases.',
      };
    case 'deployed':
      return {
        state,
        label: 'deployed',
        tone: 'warning',
        canStartCase: false,
        runTitle: 'Процесс deployed, но ещё не executable: запуск заблокирован',
        runBlockedReason: 'WORKFLOW_NOT_EXECUTABLE: lifecycle_state must be executable.',
      };
    case 'validated':
      return {
        state,
        label: 'validated',
        tone: 'warning',
        canStartCase: false,
        runTitle: 'Процесс validated: выполните deploy перед запуском',
        runBlockedReason: 'WORKFLOW_NOT_EXECUTABLE: deploy is required before case.start.',
      };
    case 'draft':
    default:
      return {
        state: 'draft',
        label: 'draft',
        tone: 'neutral',
        canStartCase: false,
        runTitle: 'Процесс draft: сохраните, провалидируйте и выполните deploy перед запуском',
        runBlockedReason: 'WORKFLOW_NOT_EXECUTABLE: draft workflows cannot start new cases.',
      };
  }
}
