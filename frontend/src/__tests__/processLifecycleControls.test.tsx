import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { EditorToolbar } from '../pages/EditorToolbar';
import { ProcessTree } from '../pages/ProcessTree';
import type { Workflow } from '../api/types';

function toolbarState(lifecycle_state: Workflow['lifecycle_state']) {
  const workflow: Workflow = {
    id: 'wf-1',
    name: 'Workflow 1',
    lifecycle_state,
    elements: [],
    flow: [],
  };
  return {
    wfId: 'wf-1',
    wfName: 'Workflow 1',
    currentWorkflow: workflow,
    currentLifecycle: lifecycle_state === 'executable'
      ? { state: 'executable', label: 'executable', tone: 'success', canStartCase: true, runTitle: 'can run' }
      : { state: lifecycle_state, label: lifecycle_state, tone: 'warning', canStartCase: false, runTitle: 'blocked', runBlockedReason: 'WORKFLOW_NOT_EXECUTABLE' },
    workflows: [workflow],
    breadcrumb: [],
    zoom: 1,
    saving: false,
    undoStack: [],
    redoStack: [],
    autosavePending: false,
    error: null,
    draftWarning: null,
    versions: [],
    viewingVersion: null,
    setViewingVersion: vi.fn(),
    loadWorkflow: vi.fn(),
    setElements: vi.fn(),
    setFlow: vi.fn(),
    setPositions: vi.fn(),
    zoomOut: vi.fn(),
    zoomIn: vi.fn(),
    zoomFit: vi.fn(),
    zoomReset: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    save: vi.fn(),
    deployWorkflow: vi.fn(),
    runCurrentWorkflow: vi.fn(),
  };
}

describe('ProcessEditor lifecycle controls', () => {
  test('disables run control and shows lifecycle warning for non-executable workflow', () => {
    render(
      <EditorToolbar
        s={toolbarState('validated') as any}
        readOnly={false}
        setReadOnly={vi.fn()}
        onToggleMobSide={vi.fn()}
      />,
    );

    expect(screen.getByText('validated')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    expect(screen.getByText('запуск заблокирован: validated')).toBeInTheDocument();
  });

  test('enables run control only for executable workflow', () => {
    render(
      <EditorToolbar
        s={toolbarState('executable') as any}
        readOnly={false}
        setReadOnly={vi.fn()}
        onToggleMobSide={vi.fn()}
      />,
    );

    expect(screen.getByText('executable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).not.toBeDisabled();
  });

  test('shows lifecycle badges in search and tree process rows', () => {
    const workflows: Workflow[] = [
      { id: 'draft-flow', name: 'Draft Flow', lifecycle_state: 'draft', elements: [], flow: [] },
      { id: 'retired-flow', name: 'Retired Flow', lifecycle_state: 'retired', elements: [], flow: [] },
    ];
    const commonProps = {
      workflows,
      wfId: '',
      sideSearch: 'flow',
      filteredWorkflows: workflows,
      workflowTree: [],
      creatingNew: false,
      newProcName: '',
      renamingWfId: null,
      renamingVal: '',
      collapsedTree: new Set<string>(),
      onSideSearch: vi.fn(),
      onLoadWorkflow: vi.fn(),
      onStartCreatingNew: vi.fn(),
      onCommitNewProc: vi.fn(),
      onNewProcNameChange: vi.fn(),
      onStartRename: vi.fn(),
      onCommitRename: vi.fn(),
      onRenamingValChange: vi.fn(),
      onDupWorkflow: vi.fn(),
      onDelWorkflow: vi.fn(),
      onCollapsedTreeChange: vi.fn(),
      onCancelCreating: vi.fn(),
      onCancelRename: vi.fn(),
      showHiddenArtifacts: false,
      hiddenArtifactCount: 0,
      onShowHiddenArtifactsChange: vi.fn(),
    };

    render(<ProcessTree {...commonProps} />);

    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByText('retired')).toBeInTheDocument();
  });
});
