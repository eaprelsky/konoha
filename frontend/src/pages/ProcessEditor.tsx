/**
 * ProcessEditor — interactive visual eEPC process editor
 * Drag elements from palette, connect with arrows, save to API.
 *
 * Modules extracted (issue #289):
 *  - ArrowRouter.ts        — pure routing functions + canvas constants
 *  - ElementShape.tsx      — ElShape component, PALETTE, DEFAULT_LABELS
 *  - MiningOverlay.tsx     — per-element SVG mining badges
 *  - TsunadeChatPanel.tsx  — AI assistant chat panel
 * Modules extracted (issue #330):
 *  - useProcessEditor.ts   — all state and logic
 *  - ProcessTree.tsx       — sidebar process library
 *  - PropertiesPanel.tsx   — element properties panel
 *  - VersionSelector.tsx   — toolbar version history dropdown
 *  - RegistryPicker.tsx    — role/doc/IS picker modal
 *  - ProcessEditor.css     — all styles
 */
import React, { useEffect } from 'react';
import { Inspector } from '../components/Inspector';
import './ProcessEditor.css';
import { EW, EH, GR, CW, CH, orthogonalPath, snap, type Pos } from './ArrowRouter';
import { ElShape, PALETTE } from './ElementShape';
import { MiningOverlay, formatDuration } from './MiningOverlay';
import { useProcessEditor } from './useProcessEditor';
import { ProcessTree } from './ProcessTree';
import { PropertiesPanel } from './PropertiesPanel';
import { VersionSelector } from './VersionSelector';
import { RegistryPicker } from './RegistryPicker';
import { Minimap } from './Minimap';
import { TriggerBadge } from './TriggerBadge';
import { TriggerPopup } from './TriggerPopup';

function isMobile() { return window.innerWidth <= 767; }

export function ProcessEditor({ initialId }: { initialId?: string }) {
  const [readOnly, setReadOnly] = React.useState(false);
  const s = useProcessEditor(readOnly);
  const [showMobProps, setShowMobProps] = React.useState(false);
  const [triggerPopupId, setTriggerPopupId] = React.useState<string | null>(null);
  // Load workflow from URL param on mount
  const { loadWorkflow } = s;
  useEffect(() => { if (initialId) loadWorkflow(initialId); }, [initialId, loadWorkflow]);

  // Load newly created workflow dispatched by AssistantWidget (#416)
  useEffect(() => {
    function onCreated(e: Event) {
      const wf = (e as CustomEvent).detail as { id: string } | null;
      if (wf?.id) loadWorkflow(wf.id);
    }
    window.addEventListener('konoha:workflow_created', onCreated);
    return () => window.removeEventListener('konoha:workflow_created', onCreated);
  }, [loadWorkflow]);

  // Sync current process schema to Inspector so AssistantWidget (Tsunade) has context (#413)
  useEffect(() => {
    if (!s.wfId) {
      Inspector.setProcessName(null);
      Inspector.setProcessSchema(null);
      return;
    }
    Inspector.setProcessName(`${s.wfName} (${s.wfId})`);

    // Build compact schema summary (keeps tokens low, covers structure)
    const lines: string[] = [
      `Current process schema — "${s.wfName}" (id: ${s.wfId}):`,
      `Elements (${s.elements.length}):`,
    ];
    for (const el of s.elements) {
      const parts = [`  [${el.type}] "${el.label || el.id}"`];
      if (el.role)   parts.push(`role: ${el.role}`);
      if (el.system) parts.push(`system: ${el.system}`);
      if (el.trigger?.kind) parts.push(`trigger: ${el.trigger.kind}${el.trigger.confidence != null ? ` (${Math.round(el.trigger.confidence * 100)}%)` : ''}`);
      if (el.intent) parts.push(`intent: ${el.intent}`);
      if (el.operator) parts.push(`op: ${el.operator}`);
      lines.push(parts.join(' · '));
    }
    if (s.flow.length > 0) {
      lines.push(`Flow (${s.flow.length} edges):`);
      // Summarise edges as label chains (max 40 to keep size bounded)
      const edgeMap: Record<string, string> = {};
      s.elements.forEach(e => { edgeMap[e.id] = e.label || e.id; });
      s.flow.slice(0, 40).forEach(([f, t]) => lines.push(`  ${edgeMap[f] ?? f} → ${edgeMap[t] ?? t}`));
      if (s.flow.length > 40) lines.push(`  … (${s.flow.length - 40} more)`);
    }
    Inspector.setProcessSchema(lines.join('\n'));
  }, [s.wfId, s.wfName, s.elements, s.flow]);

  // Sync selected element to Inspector
  useEffect(() => {
    if (!s.selEl) { Inspector.setSelectedElement(null); return; }
    Inspector.setSelectedElement(`[${s.selEl.type}] "${s.selEl.label || s.selEl.id}"${s.selEl.role ? ` (role: ${s.selEl.role})` : ''}`);
  }, [s.selEl]);

  // Open mobile props sheet when element selected on mobile
  useEffect(() => {
    if (s.selEl && isMobile()) setShowMobProps(true);
    if (!s.selEl) setShowMobProps(false);
  }, [s.selEl]);

  return (
    <>
      <div className="ipe-root">

        {/* ── Toolbar ── */}
        <div className="ipe-bar">
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
          {/* Zoom controls */}
          <button title="Zoom Out (−)" style={{ padding: '5px 8px', fontWeight: 700, fontSize: 14 }} onClick={s.zoomOut}>−</button>
          <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 36, textAlign: 'center', flexShrink: 0 }}>{Math.round(s.zoom * 100)}%</span>
          <button title="Zoom In (+)" style={{ padding: '5px 8px', fontWeight: 700, fontSize: 14 }} onClick={s.zoomIn}>+</button>
          <button title="По размеру (Fit)" style={{ padding: '5px 8px', fontSize: 12 }} onClick={s.zoomFit}>⊡</button>
          <button title="Сбросить масштаб (100%)" style={{ padding: '5px 8px', fontSize: 11 }} onClick={s.zoomReset}>1:1</button>
          {!readOnly && (
            <>
              <div className="sep" />
              <button title="Ctrl+Z" style={{ padding: '5px 8px' }} onClick={s.undo} disabled={s.undoStack.length === 0}>↩</button>
              <button title="Ctrl+Y" style={{ padding: '5px 8px' }} onClick={s.redo} disabled={s.redoStack.length === 0}>↪</button>
              <div className="sep" />
              <button className="btn-save" onClick={s.save} disabled={s.saving}>
                {s.saving ? 'Сохранение…' : '💾 Сохранить'}
              </button>
            </>
          )}
          {readOnly && <span style={{ fontSize: 12, color: '#fbbf24', background: '#1c1408', padding: '3px 10px', borderRadius: 4, border: '1px solid #78350f' }}>🔒 Просмотр</span>}
          <button
            title={readOnly ? 'Переключить в режим редактирования' : 'Переключить в режим просмотра (без случайных изменений)'}
            style={{ padding: '5px 8px', background: readOnly ? '#1e3a5f' : undefined, borderColor: readOnly ? '#3b82f6' : undefined, color: readOnly ? '#93c5fd' : undefined }}
            onClick={() => setReadOnly(r => !r)}
          >{readOnly ? '✏' : '👁'}</button>
          {s.wfId.trim() && (
            <button
              className={s.showMining ? 'active' : ''}
              onClick={s.toggleMining}
              title="Process Mining — наложить статистику реальных прогонов на схему"
              style={{ background: s.showMining ? '#065f46' : '#1e3a2f', borderColor: '#10b981' }}
            >
              {s.miningLoading ? '⏳' : '⛏'} Майнинг
            </button>
          )}
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

        <div className="ipe-body">

          {/* ── Sidebar ── */}
          <div className="ipe-side" style={{ width: s.sideW }}>

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

            {/* Element palette */}
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

            {/* Properties panel */}
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

            {/* Connection list */}
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

            {/* Mining summary */}
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
          </div>

          {/* ── Resize handle ── */}
          <div className="ipe-resize" onMouseDown={s.onResizeMouseDown} title="Drag to resize panel" />

          {/* ── Canvas ── */}
          <div className="ipe-canvas">
            <Minimap
              elements={s.elements}
              positions={s.positions}
              panX={s.panX}
              panY={s.panY}
              zoom={s.zoom}
              svgRef={s.svgRef}
            />
            <svg
              ref={s.svgRef}
              style={{ cursor: readOnly ? 'default' : s.canvasCursor }}
              onMouseDown={readOnly ? undefined : s.onSvgMouseDown}
              onMouseMove={readOnly ? undefined : s.onSvgMouseMove}
              onMouseUp={readOnly ? undefined : s.onSvgMouseUp}
              onMouseLeave={readOnly ? undefined : s.onSvgMouseUp}
              onClick={readOnly ? undefined : s.onSvgClick}
              onContextMenu={e => e.preventDefault()}
            >
              <defs>
                <pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse"
                  patternTransform={`translate(${s.panX % 20},${s.panY % 20})`}>
                  <circle cx="1" cy="1" r="1" fill="#cbd5e1" />
                </pattern>
                <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L8,3 z" fill="#6b7280" />
                </marker>
                <marker id="arr-hi" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L8,3 z" fill="#6366f1" />
                </marker>
              </defs>

              <rect width="100%" height="100%" fill="white" />
              <rect width="100%" height="100%" fill="url(#dots)" />

              <g transform={`translate(${s.panX},${s.panY}) scale(${s.zoom})`}>

              {/* Edges */}
              {s.flow.map(([fId, tId], i) => {
                const fp = s.positions[fId], tp = s.positions[tId];
                if (!fp || !tp) return null;
                const srcType = s.elements.find(e => e.id === fId)?.type;
                const dstType = s.elements.find(e => e.id === tId)?.type;
                const d = orthogonalPath(fp, tp, srcType, dstType);
                const isHighlighted = s.selected === fId || s.selected === tId
                  || s.multiSelected.includes(fId) || s.multiSelected.includes(tId);
                const isRoleEdge = srcType === 'role' || dstType === 'role';
                const arrow = isRoleEdge ? undefined : isHighlighted ? 'url(#arr-hi)' : 'url(#arr)';
                const miningEdge = s.showMining && s.miningData ? s.miningData.edges[`${fId}:${tId}`] : null;
                const edgeCount = miningEdge?.count ?? 0;
                const maxEdgeCount = s.showMining && s.miningData ? Math.max(1, ...Object.values(s.miningData.edges).map(e => e.count)) : 1;
                const miningStroke = s.showMining && s.miningData ? (edgeCount === 0 ? '#374151' : `rgba(16,185,129,${0.3 + 0.7 * edgeCount / maxEdgeCount})`) : null;
                const miningWidth = s.showMining && s.miningData ? (edgeCount === 0 ? 0.5 : 1.5 + 3 * edgeCount / maxEdgeCount) : null;
                return (
                  <g key={i}>
                    <path d={d}
                      stroke={miningStroke || (isHighlighted ? '#6366f1' : isRoleEdge ? '#B7A000' : '#6b7280')}
                      strokeWidth={miningWidth ?? (isHighlighted ? 2 : 1.5)}
                      strokeDasharray={!s.showMining && isRoleEdge ? '5 3' : (s.showMining && edgeCount === 0 ? '4 3' : undefined)}
                      fill="none" markerEnd={arrow} />
                    {!readOnly && <path d={d} stroke="transparent" strokeWidth={12} fill="none"
                      style={{ cursor: 'pointer' }}
                      onClick={e => { e.stopPropagation(); s.removeEdge(fId, tId); }} />}
                  </g>
                );
              })}

              {/* Rubber-band connection line */}
              {s.connectDrag && (
                <line x1={s.connectDrag.startX} y1={s.connectDrag.startY}
                  x2={s.connectDrag.curX} y2={s.connectDrag.curY}
                  stroke="#6366f1" strokeWidth={1.5} strokeDasharray="6 3" pointerEvents="none" />
              )}

              {/* Marquee selection box */}
              {s.marquee && (() => {
                const x = Math.min(s.marquee.sx, s.marquee.ex);
                const y = Math.min(s.marquee.sy, s.marquee.ey);
                const w = Math.abs(s.marquee.ex - s.marquee.sx);
                const h = Math.abs(s.marquee.ey - s.marquee.sy);
                return <rect x={x} y={y} width={w} height={h} fill="rgba(99,102,241,0.08)" stroke="#6366f1" strokeWidth={1.5} strokeDasharray="4 2" pointerEvents="none" />;
              })()}

              {/* Elements */}
              {s.elements.map(el => {
                const pos = s.positions[el.id] || { x: 40, y: 40 };
                const isSel = s.selected === el.id || s.multiSelected.includes(el.id);
                const isCFrom = s.connectFrom === el.id;
                const elCursor = s.connectDrag ? 'crosshair'
                  : s.mode === 'select' ? ((s.dragging?.id === el.id || s.groupDrag?.ids.includes(el.id)) ? 'grabbing' : 'grab')
                  : 'pointer';
                const isEditingThis = s.editingId === el.id;
                const showAnchors = !readOnly && s.hoveredEl === el.id && s.mode === 'select' && !s.dragging && !s.groupDrag && !s.connectDrag && !s.marquee;
                const anchors = el.type === 'gateway' ? [
                  { ax: EW / 2, ay: EH / 2 - GR }, { ax: EW / 2, ay: EH / 2 + GR },
                  { ax: EW / 2 - GR, ay: EH / 2 }, { ax: EW / 2 + GR, ay: EH / 2 },
                ] : [
                  { ax: EW / 2, ay: 0 }, { ax: EW / 2, ay: EH },
                  { ax: 0, ay: EH / 2 }, { ax: EW, ay: EH / 2 },
                ];
                return (
                  <g key={el.id} transform={`translate(${pos.x},${pos.y})`} style={{ cursor: readOnly ? 'default' : elCursor }}
                    onMouseEnter={() => s.setHoveredEl(el.id)}
                    onMouseLeave={() => s.setHoveredEl(null)}
                    onMouseDown={readOnly ? undefined : e => { if (isEditingThis) e.stopPropagation(); else s.onElMouseDown(e, el.id); }}
                    onMouseUp={readOnly ? undefined : e => s.onElMouseUp(e, el.id)}
                    onClick={e => e.stopPropagation()}
                    onDoubleClick={readOnly ? undefined : e => {
                      if (s.mode !== 'select') return;
                      e.stopPropagation();
                      if (el.locked) return;
                      if (el.type === 'gateway') { s.setGatewayPickerId(prev => prev === el.id ? null : el.id); return; }
                      s.setEditingId(el.id);
                      s.setEditingValue(String(el.label ?? ''));
                    }}
                  >
                    {el.type === 'gateway' && (
                      <circle cx={EW / 2} cy={EH / 2} r={GR + 20} fill="transparent" pointerEvents="all" />
                    )}
                    <ElShape el={el} selected={isSel} connectSrc={isCFrom} isEditing={isEditingThis} />
                    {el.type === 'function' && el.intent && !isEditingThis && (
                      <g>
                        <title>{`Интент: ${el.intent}`}</title>
                        <rect x={2} y={EH - 18} width={18} height={14} rx={3} fill="#065f46" stroke="#10b981" strokeWidth={0.5} />
                        <text x={11} y={EH - 11} textAnchor="middle" dominantBaseline="middle" fontSize={8} fill="#6ee7b7" fontFamily="system-ui" fontWeight="bold" pointerEvents="none">I</text>
                      </g>
                    )}
                    {el.type === 'function' && !isEditingThis && (
                      <g className="drill-badge" style={{ opacity: s.hoveredEl === el.id ? 0.9 : 0 }}
                        onClick={e2 => { e2.stopPropagation(); s.drillDown(el); }}>
                        <title>Детализировать (создать под-процесс)</title>
                        <rect x={EW - 24} y={EH - 20} width={22} height={18} rx={4} fill="#1e293b" stroke="#6366f1" strokeWidth={1} />
                        <text x={EW - 13} y={EH - 8} textAnchor="middle" dominantBaseline="middle" fontSize={10} fill="#93c5fd" fontFamily="system-ui" fontWeight="bold" pointerEvents="none">+</text>
                      </g>
                    )}
                    {el.locked && (
                      <g>
                        <title>Заблокировано (граница под-процесса)</title>
                        <text x={EW - 12} y={12} textAnchor="middle" dominantBaseline="middle" fontSize={10} fill="#f59e0b" fontFamily="system-ui" pointerEvents="none">🔒</text>
                      </g>
                    )}
                    {el.type === 'event' && !isEditingThis && (
                      <TriggerBadge
                        trigger={el.trigger}
                        resolving={s.triggerResolving.has(el.id)}
                        isStartEvent={!s.flow.some(([, to]) => to === el.id)}
                        onClick={() => setTriggerPopupId(prev => prev === el.id ? null : el.id)}
                      />
                    )}
                    {s.showMining && s.miningData && <MiningOverlay el={el} miningData={s.miningData} />}
                    {showAnchors && anchors.map(({ ax, ay }, i) => (
                      <circle key={i} cx={ax} cy={ay} r={5} fill="#6366f1" fillOpacity={0.85} stroke="white" strokeWidth={1.5}
                        style={{ cursor: 'crosshair' }}
                        onMouseDown={e2 => {
                          e2.stopPropagation(); e2.preventDefault();
                          const epos = s.positions[el.id] || { x: 0, y: 0 };
                          s.setConnectDrag({ fromId: el.id, startX: epos.x + ax, startY: epos.y + ay, curX: epos.x + ax, curY: epos.y + ay });
                        }}
                      />
                    ))}
                    {isEditingThis && (
                      <foreignObject x={4} y={EH / 2 - 13} width={EW - 8} height={26}>
                        <input
                          // @ts-ignore
                          xmlns="http://www.w3.org/1999/xhtml"
                          autoFocus
                          value={s.editingValue}
                          onChange={e2 => s.setEditingValue((e2.target as HTMLInputElement).value)}
                          onBlur={() => {
                            const v = s.editingValue.trim();
                            if (v) {
                              el.type === 'gateway'
                                ? s.updateElement(el.id, { operator: v, label: v })
                                : s.updateElement(el.id, { label: v });
                              s.syncEntityOnEdit(el, v);
                              // Auto-resolve trigger for event nodes after label edit
                              if (el.type === 'event') s.resolveTrigger(el.id, v);
                            }
                            s.setEditingId(null);
                          }}
                          onKeyDown={e2 => {
                            if (e2.key === 'Enter') (e2.target as HTMLInputElement).blur();
                            if (e2.key === 'Escape') s.setEditingId(null);
                          }}
                          style={{ width: '100%', height: '100%', boxSizing: 'border-box', background: 'white', border: '1.5px solid #6366f1', borderRadius: 4, padding: '2px 6px', fontSize: 12, textAlign: 'center', fontFamily: 'system-ui,-apple-system,sans-serif', outline: 'none' }}
                        />
                      </foreignObject>
                    )}
                  </g>
                );
              })}

              {/* Gateway operator picker */}
              {s.gatewayPickerId && (() => {
                const gpos = s.positions[s.gatewayPickerId] || { x: 0, y: 0 };
                const curOp = s.elements.find(e => e.id === s.gatewayPickerId)?.operator || 'AND';
                return (
                  <foreignObject x={gpos.x + EW / 2 - 44} y={gpos.y + EH / 2 - 48} width={88} height={96}>
                    <div style={{ background: 'white', border: '1px solid #ddd', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,.18)', padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {(['XOR', 'AND', 'OR'] as const).map(op => (
                        <button key={op}
                          onClick={e => { e.stopPropagation(); s.updateElement(s.gatewayPickerId!, { operator: op }); s.setGatewayPickerId(null); }}
                          style={{ padding: '5px 0', background: curOp === op ? '#6366f1' : 'white', color: curOp === op ? 'white' : '#333', border: '1px solid #e2e8f0', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                          {op}
                        </button>
                      ))}
                    </div>
                  </foreignObject>
                );
              })()}

              {s.elements.length === 0 && (
                <text x={300} y={200} textAnchor="middle" dominantBaseline="middle"
                  fontSize={14} fill="#94a3b8" fontFamily="system-ui,-apple-system,sans-serif" pointerEvents="none">
                  Кликните элемент в палитре, чтобы добавить его на холст
                </text>
              )}

              {/* Trigger popup */}
              {triggerPopupId && (() => {
                const el = s.elements.find(e => e.id === triggerPopupId);
                const pos = s.positions[triggerPopupId];
                if (!el || !pos) return null;
                return (
                  <TriggerPopup
                    el={el}
                    posX={pos.x}
                    posY={pos.y}
                    zoom={s.zoom}
                    panX={s.panX}
                    panY={s.panY}
                    onUpdate={s.updateElement}
                    onClose={() => setTriggerPopupId(null)}
                  />
                );
              })()}
              </g>
            </svg>
          </div>

        </div>
      </div>

      {/* Registry picker modal */}
      <RegistryPicker
        picker={s.picker}
        roles={s.roles}
        docs={s.docs}
        adapters={s.adapters}
        onPickFromRegistry={s.pickFromRegistry}
        onAddCustom={type => { s.addElement(type); s.setPicker(null); }}
        onClose={() => s.setPicker(null)}
      />

      {/* Mobile palette strip (#359) */}
      <div className="mob-palette">
        {PALETTE.map(p => (
          <div key={p.type} className="mob-pal-item" onClick={() => s.paletteClick(p.type)}>
            <div className="mob-pal-dot" style={{ background: p.fill, border: `1px solid ${p.stroke}` }} />
            <span className="mob-pal-label">{p.label}</span>
          </div>
        ))}
      </div>

      {/* Mobile properties bottom sheet (#359) */}
      {showMobProps && s.selEl && (
        <>
          <div className="mob-sheet-overlay" onClick={() => { setShowMobProps(false); s.setSelected(null); }} />
          <div className="mob-props-sheet">
            <div className="mob-props-handle" />
            <div className="mob-props-inner">
              <PropertiesPanel
                selEl={s.selEl}
                flow={s.flow}
                roles={s.roles}
                docs={s.docs}
                wsFiles={s.wsFiles}
                wfId={s.wfId}
                onUpdate={s.updateElement}
                onDelete={el => { s.deleteElement(el); setShowMobProps(false); }}
              />
            </div>
          </div>
        </>
      )}
    </>
  );
}
