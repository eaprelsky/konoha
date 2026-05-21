/**
 * ProcessTree — sidebar process library with search, tree, and CRUD.
 * Extracted from ProcessEditor.tsx (issue #330).
 */
import { useState, useCallback, useEffect } from 'react';
import type { Workflow } from '../api/types';
import type { WfNode } from './useProcessEditor';
import { workflowDisplayName, workflowTitle } from './processSearch';
import { workflowLifecycleView } from '../workflowLifecycle';

interface CtxMenu {
  x: number;
  y: number;
  node: Workflow;
}

interface Props {
  workflows: Workflow[];
  wfId: string;
  sideSearch: string;
  filteredWorkflows: Workflow[];
  workflowTree: WfNode[];
  creatingNew: boolean;
  newProcName: string;
  renamingWfId: string | null;
  renamingVal: string;
  collapsedTree: Set<string>;
  onSideSearch: (v: string) => void;
  onLoadWorkflow: (id: string) => void;
  onStartCreatingNew: () => void;
  onCommitNewProc: () => void;
  onNewProcNameChange: (v: string) => void;
  onStartRename: (wf: Workflow) => void;
  onCommitRename: (id: string) => void;
  onRenamingValChange: (v: string) => void;
  onDupWorkflow: (wf: Workflow) => void;
  onDelWorkflow: (wf: Workflow) => void;
  onCollapsedTreeChange: (s: Set<string>) => void;
  onCancelCreating: () => void;
  onCancelRename: () => void;
  showHiddenArtifacts: boolean;
  hiddenArtifactCount: number;
  onShowHiddenArtifactsChange: (v: boolean) => void;
}

export function ProcessTree({
  wfId, sideSearch, filteredWorkflows, workflowTree, creatingNew, newProcName,
  renamingWfId, renamingVal, collapsedTree,
  onSideSearch, onLoadWorkflow, onStartCreatingNew, onCommitNewProc, onNewProcNameChange,
  onStartRename, onCommitRename, onRenamingValChange, onDupWorkflow, onDelWorkflow,
  onCollapsedTreeChange, onCancelCreating, onCancelRename,
  showHiddenArtifacts, hiddenArtifactCount, onShowHiddenArtifactsChange,
}: Props) {
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    function close() { setCtxMenu(null); }
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close); };
  }, [ctxMenu]);

  const openCtx = useCallback((e: React.MouseEvent, node: Workflow) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  function exportWf(wf: Workflow) {
    const blob = new Blob([JSON.stringify(wf, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${wf.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function renderWorkflowLabel(wf: Workflow) {
    const label = workflowDisplayName(wf);
    const showId = Boolean(wf.name && wf.name !== wf.id);
    const lifecycle = workflowLifecycleView(wf);
    return (
      <span className="proc-item-text">
        <span className="proc-item-name-row">
          <span className="proc-item-name">{label}</span>
          <span
            className={`proc-lifecycle-badge tone-${lifecycle.tone}`}
            title={lifecycle.runTitle}
          >
            {lifecycle.label}
          </span>
        </span>
        {showId && <span className="proc-item-id">{wf.id}</span>}
      </span>
    );
  }

  function renderNode(node: WfNode): React.ReactNode {
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsedTree.has(node.id);
    return (
      <div key={node.id} className="proc-tree-node">
        <div
          className={`proc-item${wfId === node.id ? ' active' : ''}`}
          onClick={() => { if (renamingWfId !== node.id) onLoadWorkflow(node.id); }}
          onDoubleClick={e => { e.stopPropagation(); onStartRename(node); }}
          onContextMenu={e => openCtx(e, node)}
          title={workflowTitle(node)}
        >
          <span
            className="proc-item-toggle"
            onClick={e => {
              e.stopPropagation();
              if (!hasChildren) return;
              const s = new Set(collapsedTree);
              if (s.has(node.id)) s.delete(node.id); else s.add(node.id);
              onCollapsedTreeChange(s);
            }}
          >
            {hasChildren ? (isCollapsed ? '▶' : '▼') : ''}
          </span>
          {renamingWfId === node.id ? (
            <input
              className="proc-rename-input"
              autoFocus
              value={renamingVal}
              onChange={e => onRenamingValChange(e.target.value)}
              onKeyDown={e => {
                e.stopPropagation();
                if (e.key === 'Enter') onCommitRename(node.id);
                if (e.key === 'Escape') onCancelRename();
              }}
              onBlur={() => onCommitRename(node.id)}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            renderWorkflowLabel(node)
          )}
          {renamingWfId !== node.id && (
            <div className="proc-row-acts">
              <button title="Дублировать" onClick={e => { e.stopPropagation(); onDupWorkflow(node); }}>📋</button>
              <button className="del-btn" title="Удалить" onClick={e => { e.stopPropagation(); onDelWorkflow(node); }}>🗑</button>
            </div>
          )}
        </div>
        {hasChildren && !isCollapsed && (
          <div className="proc-tree-children">
            {node.children.map(child => renderNode(child))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {ctxMenu && (
        <div
          style={{
            position: 'fixed', zIndex: 9000,
            left: ctxMenu.x, top: ctxMenu.y,
            background: '#1e293b', border: '1px solid #334155',
            borderRadius: 6, padding: '4px 0',
            boxShadow: '0 8px 24px rgba(0,0,0,.4)',
            minWidth: 160, fontSize: 13, color: '#f8fafc',
          }}
          onClick={e => e.stopPropagation()}
        >
          <div style={{ padding: '3px 8px 5px', fontSize: 11, color: '#64748b', borderBottom: '1px solid #334155', marginBottom: 3 }}>
            {ctxMenu.node.name || ctxMenu.node.id}
          </div>
          {[
            { label: 'Переименовать', action: () => { onStartRename(ctxMenu.node); setCtxMenu(null); } },
            { label: 'Дублировать', action: () => { onDupWorkflow(ctxMenu.node); setCtxMenu(null); } },
            { label: 'Экспорт JSON', action: () => { exportWf(ctxMenu.node); setCtxMenu(null); } },
            { label: '—', action: null },
            { label: 'Удалить', action: () => { onDelWorkflow(ctxMenu.node); setCtxMenu(null); }, danger: true },
          ].map((item, i) => item.action === null
            ? <div key={i} style={{ height: 1, background: '#334155', margin: '3px 0' }} />
            : (
              <div
                key={i}
                onClick={item.action}
                style={{
                  padding: '7px 14px', cursor: 'pointer',
                  color: (item as any).danger ? '#fca5a5' : '#f8fafc',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#334155'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                {item.label}
              </div>
            )
          )}
        </div>
      )}
      <div className="proc-new-row">
        <h3 style={{ margin: 0 }}>Процессы</h3>
        <button className="btn-proc-new" onClick={onStartCreatingNew}>+ Новый</button>
      </div>
      <input
        className="proc-search"
        placeholder="Поиск по названию или ID…"
        value={sideSearch}
        onChange={e => onSideSearch(e.target.value)}
      />
      {hiddenArtifactCount > 0 && (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            margin: '6px 0 8px',
            fontSize: 11,
            color: '#94a3b8',
            cursor: 'pointer',
            userSelect: 'none',
          }}
          title="Показать скрытые test/debug/generated процессы. То же можно открыть через ?view=debug."
        >
          <input
            type="checkbox"
            checked={showHiddenArtifacts}
            onChange={e => onShowHiddenArtifactsChange(e.target.checked)}
          />
          Показать служебные ({hiddenArtifactCount})
        </label>
      )}
      {creatingNew && (
        <input
          className="proc-new-input"
          autoFocus
          placeholder="Название нового процесса…"
          value={newProcName}
          onChange={e => onNewProcNameChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onCommitNewProc();
            if (e.key === 'Escape') onCancelCreating();
          }}
          onBlur={() => { if (!newProcName.trim()) onCancelCreating(); else onCommitNewProc(); }}
          style={{ marginBottom: 4 }}
        />
      )}
      <div className="proc-list">
        {filteredWorkflows.length === 0 && !creatingNew && (
          <div style={{ fontSize: 11, color: '#94a3b8', padding: '4px 0' }}>Процессов пока нет</div>
        )}
        {sideSearch.trim()
          ? filteredWorkflows.map(w => (
            <div
              key={w.id}
              className={`proc-item${wfId === w.id ? ' active' : ''}`}
              onClick={() => { if (renamingWfId !== w.id) onLoadWorkflow(w.id); }}
              onDoubleClick={e => { e.stopPropagation(); onStartRename(w); }}
              onContextMenu={e => openCtx(e, w)}
              title={workflowTitle(w)}
            >
              {renamingWfId === w.id ? (
                <input
                  className="proc-rename-input"
                  autoFocus
                  value={renamingVal}
                  onChange={e => onRenamingValChange(e.target.value)}
                  onKeyDown={e => {
                    e.stopPropagation();
                    if (e.key === 'Enter') onCommitRename(w.id);
                    if (e.key === 'Escape') onCancelRename();
                  }}
                  onBlur={() => onCommitRename(w.id)}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                renderWorkflowLabel(w)
              )}
              {renamingWfId !== w.id && (
                <div className="proc-row-acts">
                  <button title="Дублировать" onClick={e => { e.stopPropagation(); onDupWorkflow(w); }}>📋</button>
                  <button className="del-btn" title="Удалить" onClick={e => { e.stopPropagation(); onDelWorkflow(w); }}>🗑</button>
                </div>
              )}
            </div>
          ))
          : workflowTree.map(node => renderNode(node))
        }
      </div>
      <hr className="load-divider" />
    </div>
  );
}
