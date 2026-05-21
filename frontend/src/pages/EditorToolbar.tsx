/**
 * EditorToolbar — top action bar for ProcessEditor.
 * Extracted from ProcessEditor.tsx (issue #448).
 */
import type { useProcessEditor } from './useProcessEditor';
import { VersionSelector } from './VersionSelector';
import { workflowLifecycleView } from '../workflowLifecycle';

interface Props {
  s: ReturnType<typeof useProcessEditor>;
  readOnly: boolean;
  setReadOnly: (fn: (r: boolean) => boolean) => void;
  onToggleMobSide: () => void;
}

export function EditorToolbar({ s, readOnly, setReadOnly, onToggleMobSide }: Props) {
  const lifecycle = s.currentLifecycle ?? workflowLifecycleView(s.currentWorkflow);
  const validation = s.validationReceipt?.workflow_id === s.wfId ? s.validationReceipt : null;
  const deployBlocked = Boolean(validation?.gates.deployment_blocker);
  const runBlockedByReadiness = Boolean(validation?.gates.case_start_blocker);
  const runnable = lifecycle.canStartCase && !runBlockedByReadiness;
  const deployTitle = deployBlocked
    ? `Deploy заблокирован: ${validation?.errors[0]?.code ?? 'validation'}`
    : 'Провалидировать, развернуть триггеры и сделать процесс доступным для запуска';
  const runTitle = runBlockedByReadiness
    ? `Case start заблокирован: ${validation?.errors[0]?.code ?? 'validation'}`
    : lifecycle.runTitle;

  return (
    <div className="ipe-bar">
      <button className="mob-side-toggle" onClick={onToggleMobSide} title="Список процессов">☰</button>

      <span style={{ color: '#94a3b8', fontSize: 12, flexShrink: 0 }}>Редактор процессов</span>

      {s.wfName && (
        <>
          <div className="sep" />
          {s.breadcrumb.length > 0 ? (
            <div className="ipe-breadcrumb">
              {s.breadcrumb.map((crumb, i) => (
                <span key={crumb.id} style={{ display: 'contents' }}>
                  {i > 0 && <span className="bc-sep">›</span>}
                  <a onClick={() => s.loadWorkflow(crumb.id, s.breadcrumb.slice(0, i))}>{crumb.name}</a>
                </span>
              ))}
              <span className="bc-sep">›</span>
              <span className="bc-current">{s.wfName}</span>
            </div>
          ) : (
            <span style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 500, flexShrink: 0, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.wfName}
            </span>
          )}
        </>
      )}

      <div className="sep" />
      {s.wfId && (
        <span
          className={`workflow-lifecycle-badge tone-${lifecycle.tone}`}
          title={lifecycle.runTitle}
        >
          {lifecycle.label}
        </span>
      )}
      <div className="sep" />
      <button title="Уменьшить масштаб (−)" style={{ padding: '5px 8px', fontWeight: 700, fontSize: 14 }} onClick={s.zoomOut}>−</button>
      <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 36, textAlign: 'center', flexShrink: 0 }}>{Math.round(s.zoom * 100)}%</span>
      <button title="Увеличить масштаб (+)" style={{ padding: '5px 8px', fontWeight: 700, fontSize: 14 }} onClick={s.zoomIn}>+</button>
      <button title="По размеру" style={{ padding: '5px 8px', fontSize: 12 }} onClick={s.zoomFit}>⊡</button>
      <button title="Сбросить масштаб (100%)" style={{ padding: '5px 8px', fontSize: 11 }} onClick={s.zoomReset}>1:1</button>

      {!readOnly && (
        <>
          <div className="sep" />
          <button title="Отменить (Ctrl+Z)" style={{ padding: '5px 8px' }} onClick={s.undo} disabled={s.undoStack.length === 0}>↩</button>
          <button title="Повторить (Ctrl+Y)" style={{ padding: '5px 8px' }} onClick={s.redo} disabled={s.redoStack.length === 0}>↪</button>
          <div className="sep" />
          <button className="btn-save" onClick={s.save} disabled={s.saving}>
            {s.saving ? 'Сохранение…' : '💾 Сохранить'}
          </button>
          <button
            title={deployTitle}
            onClick={s.deployWorkflow}
            disabled={s.saving || !s.wfId.trim() || runnable || deployBlocked}
            style={{ padding: '5px 10px', fontWeight: 600 }}
          >
            Deploy
          </button>
          <button
            title={runTitle}
            onClick={s.runCurrentWorkflow}
            disabled={s.saving || !s.wfId.trim() || !runnable}
            aria-disabled={s.saving || !s.wfId.trim() || !runnable}
            style={{ padding: '5px 10px', fontWeight: 600 }}
          >
            Run
          </button>
          {s.wfId && (!runnable || deployBlocked) && (
            <span className="run-disabled-hint" title={runBlockedByReadiness ? runTitle : lifecycle.runBlockedReason}>
              запуск заблокирован: {runBlockedByReadiness ? validation?.errors[0]?.code : lifecycle.label}
            </span>
          )}
        </>
      )}

      {readOnly && (
        <span style={{ fontSize: 12, color: '#fbbf24', background: '#1c1408', padding: '3px 10px', borderRadius: 4, border: '1px solid #78350f' }}>
          🔒 Просмотр
        </span>
      )}

      <button
        title={readOnly ? 'Переключить в режим редактирования' : 'Переключить в режим просмотра (без случайных изменений)'}
        style={{ padding: '5px 8px', background: readOnly ? '#1e3a5f' : undefined, borderColor: readOnly ? '#3b82f6' : undefined, color: readOnly ? '#93c5fd' : undefined }}
        onClick={() => setReadOnly(r => !r)}
      >{readOnly ? '✏' : '👁'}</button>

      <VersionSelector
        versions={s.versions}
        viewingVersion={s.viewingVersion}
        wfId={s.wfId}
        onViewVersion={s.setViewingVersion}
        onResetVersion={() => { s.setViewingVersion(null); s.loadWorkflow(s.wfId); }}
        onLoadPositions={(els, pos) => { s.setElements([...els]); s.setFlow([]); s.setPositions(pos); }}
      />

      {s.autosavePending && !s.saving && <span style={{ color: '#94a3b8', fontSize: 11 }}>автосохранение…</span>}
      {s.error && <span style={{ color: '#fca5a5', fontSize: 12 }}>{s.error}</span>}
      {s.draftWarning && (
        <span className="warn-wrap" style={{ color: '#fbbf24', fontSize: 12 }}>
          ⚠ {s.draftWarning.text}{s.draftWarning.details.length > 0 ? ' ▾' : ''}
          {s.draftWarning.details.length > 0 && (
            <div className="warn-pop">
              <ul>{s.draftWarning.details.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </div>
          )}
        </span>
      )}
    </div>
  );
}
