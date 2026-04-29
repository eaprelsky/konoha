import { PALETTE } from './ElementShape';
import { formatDuration } from './MiningOverlay';
import { ProcessTree } from './ProcessTree';
import { PropertiesPanel } from './PropertiesPanel';
import type { useProcessEditor } from './useProcessEditor';

type ProcessEditorState = ReturnType<typeof useProcessEditor>;

export function ProcessEditorSidebar({ s }: { s: ProcessEditorState }) {
  return (
    <>
      <ProcessTree
        workflows={s.workflows}
        wfId={s.wfId}
        sideSearch={s.sideSearch}
        filteredWorkflows={s.filteredWorkflows}
        workflowTree={s.workflowTree}
        creatingNew={s.creatingNew}
        newProcName={s.newProcName}
        renamingWfId={s.renamingWfId}
        renamingVal={s.renamingVal}
        collapsedTree={s.collapsedTree}
        onSideSearch={s.setSideSearch}
        onLoadWorkflow={s.loadWorkflow}
        onStartCreatingNew={s.startCreatingNew}
        onCommitNewProc={s.commitNewProc}
        onNewProcNameChange={s.setNewProcName}
        onStartRename={s.startRename}
        onCommitRename={s.commitRename}
        onRenamingValChange={s.setRenamingVal}
        onDupWorkflow={s.dupWorkflow}
        onDelWorkflow={s.delWorkflow}
        onCollapsedTreeChange={s.setCollapsedTree}
        onCancelCreating={() => { s.setCreatingNew(false); s.setNewProcName(''); }}
        onCancelRename={() => s.setRenamingVal('')}
      />

      <div>
        <h3>Добавить элемент</h3>
        {PALETTE.map(p => (
          <div key={p.type} className="pal-item" onClick={() => s.paletteClick(p.type)}>
            <div className="pal-dot" style={{ background: p.fill, border: `1px solid ${p.stroke}` }} />
            <span style={{ flex: 1 }}>{p.label}</span>
            {(p.type === 'role' && s.roles.length > 0) ||
             (p.type === 'document' && s.docs.length > 0) ||
             (p.type === 'information_system' && s.adapters.length > 0)
              ? <span style={{ fontSize: 10, color: '#94a3b8' }}>▾</span> : null}
          </div>
        ))}
        <div style={{ marginTop: 8, padding: '6px 8px', background: '#0f172a', border: '1px solid #1e293b', borderRadius: 5, fontSize: 10, color: '#64748b', lineHeight: 1.5 }}>
          <span style={{ color: '#94a3b8', fontWeight: 600 }}>Подпроцесс:</span> наведите курсор на функцию → нажмите <span style={{ color: '#93c5fd', fontWeight: 700 }}>+</span> в правом нижнем углу
        </div>
      </div>

      {s.selEl && (
        <PropertiesPanel
          selEl={s.selEl}
          flow={s.flow}
          roles={s.roles}
          docs={s.docs}
          wsFiles={s.wsFiles}
          wfId={s.wfId}
          onUpdate={s.updateElement}
          onDelete={s.deleteElement}
        />
      )}

      {s.flow.length > 0 && (
        <div>
          <h3>Связи ({s.flow.length})</h3>
          {s.flow.map(([f, t], i) => (
            <div key={i} className="edge-item">
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f} → {t}</span>
              <button className="edge-del" onClick={() => s.removeEdge(f, t)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {s.showMining && s.miningData && (
        <div>
          <h3>⛏ Майнинг — {s.miningData.case_count} прогон(ов)</h3>
          {s.miningData.bottleneck_element_id && (
            <div style={{ fontSize: 11, color: '#fca5a5', background: '#450a0a', padding: '4px 8px', borderRadius: 4, marginBottom: 6 }}>
              🔥 Узкое место: {s.miningData.elements[s.miningData.bottleneck_element_id]?.label || s.miningData.bottleneck_element_id}
              {s.miningData.elements[s.miningData.bottleneck_element_id]?.avg_duration_ms != null && (
                <span> — {formatDuration(s.miningData.elements[s.miningData.bottleneck_element_id]!.avg_duration_ms!)}</span>
              )}
            </div>
          )}
          {s.miningData.skipped_elements.length > 0 && (
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
              ⬜ Пропущено: {s.miningData.skipped_elements.map(id => s.miningData!.elements[id]?.label || id).join(', ')}
            </div>
          )}
          {s.miningData.deviation_elements.length > 0 && (
            <div style={{ fontSize: 11, color: '#fbbf24', marginBottom: 4 }}>
              ⚠ Отклонения: {s.miningData.deviation_elements.map(id => s.miningData!.elements[id]?.label || id).join(', ')}
            </div>
          )}
          <div style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>Наведите на элемент на схеме для статистики</div>
        </div>
      )}
    </>
  );
}
