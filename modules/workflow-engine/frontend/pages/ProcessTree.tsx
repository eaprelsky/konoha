/**
 * ProcessTree — sidebar process library with search, tree, and CRUD.
 * Extracted from ProcessEditor.tsx (issue #330).
 */
import type React from 'react';
import type { Workflow } from '@core/api/types';
import type { WfNode } from './useProcessEditor';

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
}

export function ProcessTree({
  wfId, sideSearch, filteredWorkflows, workflowTree, creatingNew, newProcName,
  renamingWfId, renamingVal, collapsedTree,
  onSideSearch, onLoadWorkflow, onStartCreatingNew, onCommitNewProc, onNewProcNameChange,
  onStartRename, onCommitRename, onRenamingValChange, onDupWorkflow, onDelWorkflow,
  onCollapsedTreeChange, onCancelCreating, onCancelRename,
}: Props) {

  function renderNode(node: WfNode): React.ReactNode {
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsedTree.has(node.id);
    return (
      <div key={node.id} className="proc-tree-node">
        <div
          className={`proc-item${wfId === node.id ? ' active' : ''}`}
          onClick={() => { if (renamingWfId !== node.id) onLoadWorkflow(node.id); }}
          onDoubleClick={e => { e.stopPropagation(); onStartRename(node); }}
          title={node.id}
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
            <span className="proc-item-name">{node.name || node.id}</span>
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
      <div className="proc-new-row">
        <h3 style={{ margin: 0 }}>Процессы</h3>
        <button className="btn-proc-new" onClick={onStartCreatingNew}>+ Новый</button>
      </div>
      <input
        className="proc-search"
        placeholder="Поиск по названию…"
        value={sideSearch}
        onChange={e => onSideSearch(e.target.value)}
      />
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
              title={w.id}
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
                <span className="proc-item-name">{w.name || w.id}</span>
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
