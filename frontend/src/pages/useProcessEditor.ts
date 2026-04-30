/**
 * useProcessEditor — all state and logic for ProcessEditor.
 * Extracted from ProcessEditor.tsx (issue #330).
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useToken } from '../context/TokenContext';
import { api } from '../api/client';
import type { Workflow, WorkflowElement, RoleDef, DocTemplate, ProcessMiningData } from '../api/types';
import { EW, EH, snap, pinchDist, genId, slugify, type Pos, type EType } from './ArrowRouter';
import { Inspector } from '../components/Inspector';
import { DEFAULT_LABELS } from './ElementShape';
import { applyPatchToState } from './applyPatchHelper';
import { filterOperatorWorkflows, useOperatorViewMode } from '../utils/operatorView';

export type Mode = 'select' | 'connect';

export interface SchemaPatch {
  update_elements?: { id: string; [key: string]: unknown }[];
  update_positions?: Record<string, Pos>;
  add_elements?: { id?: string; x?: number; y?: number; type?: string; label?: string; [key: string]: unknown }[];
  remove_elements?: string[];
  add_flow?: [string, string][];
  remove_flow?: [string, string][];
}
export type Snapshot = { els: WorkflowElement[]; fl: [string, string, string?][]; pos: Record<string, Pos> };
export type WfNode = Workflow & { children: WfNode[] };

export interface DraftWarning { text: string; details: string[] }

export function useProcessEditor(readOnly = false) {
  const token = useToken();
  const { showHiddenArtifacts, setShowHiddenArtifacts } = useOperatorViewMode();

  // ── Workflow canvas state ────────────────────────────────────────────────────
  const [wfId,   setWfId]   = useState('');
  const [wfName, setWfName] = useState('');
  const [elements, setElements] = useState<WorkflowElement[]>([]);
  const [positions, setPositions] = useState<Record<string, Pos>>({});
  const [flow, setFlow] = useState<[string, string, string?][]>([]);
  const [selected,      setSelected]      = useState<string | null>(null);
  const [multiSelected, setMultiSelected] = useState<string[]>([]);
  const [connectFrom,   setConnectFrom]   = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('select');
  const [dragging, setDragging] = useState<{ id: string; ox: number; oy: number; mx: number; my: number } | null>(null);
  const [groupDrag, setGroupDrag] = useState<{ ids: string[]; startPos: Record<string, Pos>; mx: number; my: number } | null>(null);
  const [marquee, setMarquee] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null);
  const [hoveredEl, setHoveredEl] = useState<string | null>(null);
  const [connectDrag, setConnectDrag] = useState<{ fromId: string; startX: number; startY: number; curX: number; curY: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [error,  setError]  = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draftWarning, setDraftWarning] = useState<DraftWarning | null>(null);
  const [gatewayPickerId, setGatewayPickerId] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<Snapshot[]>([]);
  const [redoStack, setRedoStack] = useState<Snapshot[]>([]);
  const [autosavePending, setAutosavePending] = useState(false);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [sideW,   setSideW]   = useState(240);
  const [versions, setVersions] = useState<{ version: string; saved_at?: string }[]>([]);
  const [viewingVersion, setViewingVersion] = useState<string | null>(null);
  const [roles,    setRoles]    = useState<RoleDef[]>([]);
  const [docs,     setDocs]     = useState<DocTemplate[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<{ id: string; name: string }[]>([]);
  const [adapters, setAdapters] = useState<string[]>([]);
  const [wsFiles,  setWsFiles]  = useState<string[]>([]);
  const [showChat, setShowChat] = useState(false);
  const [picker,   setPicker]   = useState<'role' | 'document' | 'is' | null>(null);
  const [triggerResolving, setTriggerResolving] = useState<Set<string>>(new Set());
  const [sideSearch,    setSideSearch]    = useState('');
  const [creatingNew,   setCreatingNew]   = useState(false);
  const [newProcName,   setNewProcName]   = useState('');
  const [renamingWfId,  setRenamingWfId]  = useState<string | null>(null);
  const [renamingVal,   setRenamingVal]   = useState('');
  const [collapsedTree, setCollapsedTree] = useState<Set<string>>(new Set());
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [showMining, setShowMining] = useState(false);
  const [miningData, setMiningData] = useState<ProcessMiningData | null>(null);
  const [miningLoading, setMiningLoading] = useState(false);

  // ── Refs ──────────────────────────────────────────────────────────────────────
  const svgRef        = useRef<SVGSVGElement>(null);
  const resizing      = useRef(false);
  const resizeStartX  = useRef(0);
  const resizeStartW  = useRef(240);
  const justMarqueed  = useRef(false);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef       = useRef<() => Promise<boolean>>(async () => false);
  const panStart      = useRef<{ cx: number; cy: number; px: number; py: number } | null>(null);
  const touchPinch    = useRef<{ dist: number; z: number } | null>(null);
  const panXRef       = useRef(0);
  const panYRef       = useRef(0);
  const zoomRef       = useRef(1);

  // ── Load workflow list + registries ──────────────────────────────────────────
  const refreshList = useCallback(() => {
    if (!token) return;
    api.workflows.list().then(setWorkflows).catch(() => {});
  }, [token]);
  useEffect(() => { refreshList(); }, [refreshList]);
  useEffect(() => {
    if (!token) return;
    api.roles.list().then(setRoles).catch(() => {});
    api.documents.list().then(setDocs).catch(() => {});
    api.adapters.list().then(r => setAdapters(r.adapters)).catch(() => {});
    api.workspace.list().then(files => setWsFiles(files.map(f => f.name))).catch(() => {});
  }, [token]);

  // ── Sidebar resize ────────────────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (resizing.current) {
        const delta = e.clientX - resizeStartX.current;
        setSideW(Math.max(160, Math.min(480, resizeStartW.current + delta)));
      }
      if (panStart.current) {
        const dx = e.clientX - panStart.current.cx;
        const dy = e.clientY - panStart.current.cy;
        setPanX(panStart.current.px + dx);
        setPanY(panStart.current.py + dy);
      }
    };
    const onUp = () => { resizing.current = false; panStart.current = null; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  function onResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    resizing.current = true;
    resizeStartX.current = e.clientX;
    resizeStartW.current = sideW;
  }

  // ── Touch events (pan + pinch zoom) ──────────────────────────────────────────
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        const target = e.target as Element;
        if (target === svg || target.tagName === 'rect' || target.tagName === 'svg') {
          panStart.current = { cx: t.clientX, cy: t.clientY, px: panXRef.current, py: panYRef.current };
        }
      } else if (e.touches.length === 2) {
        touchPinch.current = { dist: pinchDist(e.touches), z: zoomRef.current };
        panStart.current = null;
      }
    }
    function onTouchMove(e: TouchEvent) {
      e.preventDefault();
      if (e.touches.length === 1 && panStart.current) {
        const t = e.touches[0];
        const dx = t.clientX - panStart.current.cx;
        const dy = t.clientY - panStart.current.cy;
        setPanX(panStart.current.px + dx);
        setPanY(panStart.current.py + dy);
      } else if (e.touches.length === 2 && touchPinch.current) {
        const newDist = pinchDist(e.touches);
        const scale = newDist / touchPinch.current.dist;
        setZoom(Math.max(0.25, Math.min(3, touchPinch.current.z * scale)));
      }
    }
    function onTouchEnd() { panStart.current = null; touchPinch.current = null; }
    svg.addEventListener('touchstart', onTouchStart);
    svg.addEventListener('touchmove', onTouchMove, { passive: false });
    svg.addEventListener('touchend', onTouchEnd);
    return () => {
      svg.removeEventListener('touchstart', onTouchStart);
      svg.removeEventListener('touchmove', onTouchMove);
      svg.removeEventListener('touchend', onTouchEnd);
    };
  }, []); // refs; no state deps needed

  // ── Mouse wheel zoom ─────────────────────────────────────────────────────────
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const newZoom = Math.max(0.15, Math.min(4, zoomRef.current * factor));
      const r = svg!.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const newPanX = mx - (mx - panXRef.current) * (newZoom / zoomRef.current);
      const newPanY = my - (my - panYRef.current) * (newZoom / zoomRef.current);
      setPanX(newPanX); panXRef.current = newPanX;
      setPanY(newPanY); panYRef.current = newPanY;
      setZoom(newZoom); zoomRef.current = newZoom;
    }
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []); // refs only

  // ── Undo / redo ──────────────────────────────────────────────────────────────
  function pushSnapshot() {
    setUndoStack(prev => [...prev.slice(-49), { els: elements, fl: flow, pos: positions }]);
    setRedoStack([]);
  }

  function undo() {
    if (undoStack.length === 0) return;
    const s = undoStack[undoStack.length - 1];
    setUndoStack(undoStack.slice(0, -1));
    setRedoStack(prev => [...prev.slice(-49), { els: elements, fl: flow, pos: positions }]);
    setElements(s.els); setFlow(s.fl); setPositions(s.pos);
    setSelected(null); setMultiSelected([]);
  }

  function redo() {
    if (redoStack.length === 0) return;
    const s = redoStack[redoStack.length - 1];
    setRedoStack(redoStack.slice(0, -1));
    setUndoStack(prev => [...prev.slice(-49), { els: elements, fl: flow, pos: positions }]);
    setElements(s.els); setFlow(s.fl); setPositions(s.pos);
    setSelected(null); setMultiSelected([]);
  }

  // ── Autosave ──────────────────────────────────────────────────────────────────
  function scheduleAutosave() {
    if (!wfName.trim()) return;
    setAutosavePending(true);
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(async () => {
      await saveRef.current();
      setAutosavePending(false);
    }, 2000);
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  const undoRef = useRef(undo); undoRef.current = undo;
  const redoRef = useRef(redo); redoRef.current = redo;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (readOnly) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); undoRef.current(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); redoRef.current(); return; }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const toDelete = multiSelected.length > 0 ? multiSelected : selected ? [selected] : [];
      toDelete.forEach(id => deleteElement(id));
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [selected, multiSelected, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Element management ────────────────────────────────────────────────────────
  function addElement(type: EType, label?: string, refId?: string) {
    pushSnapshot(); scheduleAutosave();
    const id  = genId(type, elements);
    const idx = elements.length;
    const col = idx % 6, row = Math.floor(idx / 6);
    const pos: Pos = { x: snap(40 + col * (EW + 60)), y: snap(40 + row * (EH + 80)) };
    const el: WorkflowElement = { id, type, label: label || DEFAULT_LABELS[type] || type };
    if (type === 'gateway') el.operator = 'AND';
    if (refId) el.ref_id = refId;
    setElements(prev => [...prev, el]);
    setPositions(prev => ({ ...prev, [id]: pos }));
    setSelected(id); setMultiSelected([id]);
    setMode('select');
  }

  function paletteClick(type: EType) {
    if (type === 'role'               && roles.length    > 0) { setPicker('role');     return; }
    if (type === 'document'           && docs.length     > 0) { setPicker('document'); return; }
    if (type === 'information_system' && adapters.length > 0) { setPicker('is');       return; }
    addElement(type);
  }

  function pickFromRegistry(name: string, refId: string) {
    const elType: EType = picker === 'is' ? 'information_system' : picker!;
    addElement(elType, name, refId);
    setPicker(null);
  }

  function deleteElement(id: string) {
    const el = elements.find(e => e.id === id);
    if (el?.locked) return;
    pushSnapshot(); scheduleAutosave();
    setElements(prev => prev.filter(e => e.id !== id));
    setFlow(prev => prev.filter(([f, t]) => f !== id && t !== id));
    setPositions(prev => { const n = { ...prev }; delete n[id]; return n; });
    if (selected === id) setSelected(null);
    setMultiSelected(prev => prev.filter(i => i !== id));
    setConnectFrom(null);
  }

  function updateElement(id: string, patch: Partial<WorkflowElement>) {
    pushSnapshot(); scheduleAutosave();
    setElements(prev => prev.map(e => e.id === id ? { ...e, ...patch } : e));
  }

  function removeEdge(f: string, t: string) {
    pushSnapshot(); scheduleAutosave();
    setFlow(prev => prev.filter(([a, b]) => !(a === f && b === t)));
  }

  // ── Schema patch via DOM event (issue #416: AssistantWidget → canvas) ────────
  // Pure transformation logic lives in applyPatchHelper.ts for unit testability (issue #461).
  function applyPatch(patch: SchemaPatch) {
    if (readOnly) return;
    pushSnapshot(); scheduleAutosave();
    const next = applyPatchToState({ elements, flow, positions }, patch);
    setElements(next.elements);
    setFlow(next.flow);
    setPositions(next.positions);
  }

  // Listen for patches dispatched by AssistantWidget
  useEffect(() => {
    (window as any).__konoha_apply_schema_patch = applyPatch;
    function onPatch(e: Event) {
      applyPatch((e as CustomEvent).detail);
    }
    window.addEventListener('konoha:schema_patch', onPatch);
    return () => {
      window.removeEventListener('konoha:schema_patch', onPatch);
      if ((window as any).__konoha_apply_schema_patch === applyPatch) {
        delete (window as any).__konoha_apply_schema_patch;
      }
    };
  }, [readOnly, elements, flow, positions]);

  // ── Zoom controls (issue #414) ───────────────────────────────────────────────
  function zoomBy(factor: number) {
    const svg = svgRef.current;
    const w = svg?.clientWidth ?? 800;
    const h = svg?.clientHeight ?? 600;
    const newZoom = Math.max(0.15, Math.min(4, zoom * factor));
    // Keep viewport center fixed
    setPanX(w / 2 - (w / 2 - panX) * (newZoom / zoom));
    setPanY(h / 2 - (h / 2 - panY) * (newZoom / zoom));
    setZoom(newZoom);
  }
  function zoomIn()    { zoomBy(1.25); }
  function zoomOut()   { zoomBy(0.8); }
  function zoomReset() { setZoom(1); setPanX(0); setPanY(0); }
  function zoomFit() {
    const svg = svgRef.current;
    if (!svg || elements.length === 0) return;
    const w = svg.clientWidth;
    const h = svg.clientHeight;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const EW_VAL = 160, EH_VAL = 58;
    for (const el of elements) {
      const p = positions[el.id];
      if (!p) continue;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + EW_VAL); maxY = Math.max(maxY, p.y + EH_VAL);
    }
    if (!isFinite(minX)) return;
    const PAD = 40;
    minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
    const newZoom = Math.min(4, Math.max(0.15, Math.min(w / (maxX - minX), h / (maxY - minY))));
    setZoom(newZoom);
    setPanX(w / 2 - ((minX + maxX) / 2) * newZoom);
    setPanY(h / 2 - ((minY + maxY) / 2) * newZoom);
  }

  // ── Trigger auto-resolve (issue #412) ────────────────────────────────────────
  async function resolveTrigger(elId: string, label: string) {
    const el = elements.find(e => e.id === elId);
    if (!el || el.type !== 'event') return;
    if (el.trigger?.manual_override) return;
    // Skip if already resolved with same label and high confidence
    if (
      el.trigger?.kind && el.trigger.kind !== 'ambiguous' &&
      (el.trigger.confidence ?? 0) > 0.7 &&
      el.label === label
    ) return;

    setTriggerResolving(prev => new Set([...prev, elId]));
    try {
      const res = await fetch('/api/trigger-resolver/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, process_context: { process_id: wfId || 'unknown' } }),
      });
      if (res.ok) {
        const data = await res.json() as { trigger?: WorkflowElement['trigger'] };
        if (data.trigger) {
          // Update trigger without snapshot (auto-resolved, not user action)
          setElements(prev => prev.map(e => e.id === elId ? { ...e, trigger: data.trigger } : e));
          scheduleAutosave();
        }
      }
    } catch { /* silent — resolver unavailable */ }
    setTriggerResolving(prev => { const s = new Set(prev); s.delete(elId); return s; });
  }

  // ── Tsunade patch handler (simplified applyPatch for AI assistant) ────────────
  function applyTsunadePatch(patch: SchemaPatch) {
    pushSnapshot();
    if (patch.update_elements?.length) {
      patch.update_elements.forEach(upd => {
        if (upd.id) { const { id, ...rest } = upd; updateElement(id as string, rest as Partial<WorkflowElement>); }
      });
    }
    if (patch.update_positions) setPositions(prev => ({ ...prev, ...patch.update_positions }));
    if (patch.add_elements?.length) {
      patch.add_elements.forEach(el => {
        const id = el.id || `el-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const { x = 100, y = 100, ...rest } = el;
        setElements(prev => [...prev, { id, type: (rest.type || 'function') as EType, label: (rest.label as string) || 'Новый элемент', ...rest } as WorkflowElement]);
        setPositions(prev => ({ ...prev, [id]: { x: x as number, y: y as number } }));
      });
    }
    if (patch.remove_elements?.length) {
      patch.remove_elements.forEach(id => {
        setElements(prev => prev.filter(e => e.id !== id));
        setPositions(prev => { const n = { ...prev }; delete n[id]; return n; });
        setFlow(prev => prev.filter(([f, t]) => f !== id && t !== id));
      });
    }
  }

  // ── SVG mouse handlers ────────────────────────────────────────────────────────
  function svgCoords(e: React.MouseEvent): Pos {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - panX) / zoom, y: (e.clientY - r.top - panY) / zoom };
  }

  function onElMouseDown(e: React.MouseEvent, id: string) {
    e.stopPropagation(); e.preventDefault();
    setGatewayPickerId(null);
    if (mode === 'connect') {
      if (!connectFrom) {
        setConnectFrom(id); setSelected(id);
      } else if (connectFrom !== id) {
        if (!flow.some(([f, t]) => f === connectFrom && t === id)) {
          setFlow(prev => [...prev, [connectFrom, id]]);
        }
        const srcEl = elements.find(e => e.id === connectFrom);
        const dstEl = elements.find(e => e.id === id);
        if (srcEl?.type === 'role' && dstEl?.type === 'function') updateElement(dstEl.id, { role: srcEl.label });
        else if (srcEl?.type === 'function' && dstEl?.type === 'role') updateElement(srcEl.id, { role: dstEl.label });
        setConnectFrom(null); setSelected(id);
      }
      return;
    }
    const pt = svgCoords(e);
    if (multiSelected.length > 1 && multiSelected.includes(id)) {
      const startPos: Record<string, Pos> = {};
      multiSelected.forEach(sid => { startPos[sid] = positions[sid] || { x: 0, y: 0 }; });
      setGroupDrag({ ids: multiSelected, startPos, mx: pt.x, my: pt.y });
      return;
    }
    const pos = positions[id] || { x: 0, y: 0 };
    setDragging({ id, ox: pos.x, oy: pos.y, mx: pt.x, my: pt.y });
    setSelected(id); setMultiSelected([id]);
  }

  function onSvgMouseDown(e: React.MouseEvent) {
    if (e.button === 2) {
      panStart.current = { cx: e.clientX, cy: e.clientY, px: panXRef.current, py: panYRef.current };
      e.preventDefault(); return;
    }
    if (mode !== 'select' || connectDrag) return;
    const pt = svgCoords(e);
    setMarquee({ sx: pt.x, sy: pt.y, ex: pt.x, ey: pt.y });
    setSelected(null); setMultiSelected([]);
  }

  function onSvgMouseMove(e: React.MouseEvent) {
    const pt = svgCoords(e);
    if (dragging) {
      const nx = snap(Math.max(0, dragging.ox + (pt.x - dragging.mx)));
      const ny = snap(Math.max(0, dragging.oy + (pt.y - dragging.my)));
      setPositions(prev => ({ ...prev, [dragging.id]: { x: nx, y: ny } }));
    }
    if (groupDrag) {
      const dx = pt.x - groupDrag.mx, dy = pt.y - groupDrag.my;
      const newPos = { ...positions };
      groupDrag.ids.forEach(id => {
        const sp = groupDrag.startPos[id];
        newPos[id] = { x: snap(Math.max(0, sp.x + dx)), y: snap(Math.max(0, sp.y + dy)) };
      });
      setPositions(newPos);
    }
    if (connectDrag) setConnectDrag(prev => prev ? { ...prev, curX: pt.x, curY: pt.y } : null);
    if (marquee) setMarquee(prev => prev ? { ...prev, ex: pt.x, ey: pt.y } : null);
  }

  function onSvgMouseUp() {
    if (dragging || groupDrag) scheduleAutosave();
    setDragging(null); setGroupDrag(null); setConnectDrag(null);
    if (marquee) {
      const minX = Math.min(marquee.sx, marquee.ex);
      const maxX = Math.max(marquee.sx, marquee.ex);
      const minY = Math.min(marquee.sy, marquee.ey);
      const maxY = Math.max(marquee.sy, marquee.ey);
      if (maxX - minX > 8 || maxY - minY > 8) {
        const ids = elements.filter(el => {
          const pos = positions[el.id];
          if (!pos) return false;
          return pos.x < maxX && pos.x + EW > minX && pos.y < maxY && pos.y + EH > minY;
        }).map(el => el.id);
        setMultiSelected(ids);
        if (ids.length === 1) setSelected(ids[0]);
        justMarqueed.current = true;
      }
      setMarquee(null);
    }
  }

  function onElMouseUp(e: React.MouseEvent, toId: string) {
    if (!connectDrag || connectDrag.fromId === toId) return;
    e.stopPropagation();
    const fromId = connectDrag.fromId;
    if (!flow.some(([f, t]) => f === fromId && t === toId)) {
      pushSnapshot(); scheduleAutosave();
      setFlow(prev => [...prev, [fromId, toId]]);
    }
    const srcEl = elements.find(el => el.id === fromId);
    const dstEl = elements.find(el => el.id === toId);
    if (srcEl?.type === 'role' && dstEl?.type === 'function') updateElement(dstEl.id, { role: srcEl.label });
    else if (srcEl?.type === 'function' && dstEl?.type === 'role') updateElement(srcEl.id, { role: dstEl.label });
    setConnectDrag(null);
  }

  function onSvgClick() {
    setGatewayPickerId(null);
    if (justMarqueed.current) { justMarqueed.current = false; return; }
    if (mode === 'connect' && connectFrom) setConnectFrom(null);
    else { setSelected(null); setMultiSelected([]); }
  }

  function switchMode(m: Mode) {
    setMode(m); setConnectFrom(null);
    if (m === 'connect') { setSelected(null); setMultiSelected([]); }
  }

  // ── Process CRUD ──────────────────────────────────────────────────────────────
  function newProcess() {
    setWfId(''); setWfName(''); setElements([]); setFlow([]); setPositions({});
    setSelected(null); setMultiSelected([]); setConnectFrom(null); setMode('select'); setError(null);
    setBreadcrumb([]);
  }

  function startCreatingNew() { setCreatingNew(true); setNewProcName(''); }

  function commitNewProc() {
    const name = newProcName.trim();
    setCreatingNew(false); setNewProcName('');
    if (!name) return;
    const id = slugify(name) || `process-${Date.now().toString(36)}`;
    setWfId(id); setWfName(name); setElements([]); setFlow([]); setPositions({});
    setSelected(null); setMultiSelected([]); setConnectFrom(null); setMode('select'); setError(null);
  }

  function startRename(wf: Workflow) { setRenamingWfId(wf.id); setRenamingVal(wf.name || wf.id); }

  async function commitRename(id: string) {
    const name = renamingVal.trim();
    setRenamingWfId(null);
    if (!name || name === workflows.find(w => w.id === id)?.name) return;
    if (wfId === id) setWfName(name);
    const wf = workflows.find(w => w.id === id);
    if (!wf) return;
    try {
      await api.workflows.update(id, { ...wf, name } as unknown as Workflow);
      refreshList();
    } catch (err: any) { setError(err.message); }
  }

  async function dupWorkflow(wf: Workflow) {
    try {
      await api.workflows.create({ ...wf, id: `${wf.id}-copy`, name: `${wf.name || wf.id} (копия)` } as unknown as Workflow);
      refreshList();
    } catch (err: any) { setError(err.message); }
  }

  async function delWorkflow(wf: Workflow) {
    if (!confirm(`Удалить процесс "${wf.name || wf.id}"?`)) return;
    try {
      await api.workflows.delete(wf.id);
      if (wfId === wf.id) newProcess();
      refreshList();
    } catch (err: any) { setError(err.message); }
  }

  function loadWorkflow(id: string, fromBreadcrumb?: { id: string; name: string }[]) {
    const wf = workflows.find(w => w.id === id);
    if (!wf) return;
    setWfId(wf.id); setWfName(wf.name || wf.id);
    Inspector.setProcessName(wf.name || wf.id);
    setViewingVersion(null);
    api.workflows.versions(id).then(setVersions).catch(() => setVersions([]));
    setElements([...wf.elements]); setFlow([...(wf.flow || [])]);
    setSelected(null); setMultiSelected([]); setConnectFrom(null); setMode('select');
    const pos: Record<string, Pos> = {};
    wf.elements.forEach((el, i) => {
      if (typeof el.x === 'number' && typeof el.y === 'number' && (el.x !== 0 || el.y !== 0)) {
        pos[el.id] = { x: el.x, y: el.y };
      } else {
        const col = i % 6, row = Math.floor(i / 6);
        pos[el.id] = { x: snap(40 + col * (EW + 60)), y: snap(40 + row * (EH + 80)) };
      }
    });
    setPositions(pos);
    if (fromBreadcrumb !== undefined) {
      setBreadcrumb(fromBreadcrumb);
    } else if (wf.parent_id) {
      const chain: { id: string; name: string }[] = [];
      let cur: Workflow | undefined = wf;
      const visited = new Set<string>();
      while (cur && cur.parent_id && !visited.has(cur.id)) {
        visited.add(cur.id);
        const parent = workflows.find(w => w.id === cur!.parent_id);
        if (parent) chain.unshift({ id: parent.id, name: parent.name || parent.id });
        cur = parent;
      }
      setBreadcrumb(chain);
    } else {
      setBreadcrumb([]);
    }
  }

  async function drillDown(funcEl: WorkflowElement) {
    if (!wfId) return;
    const saved = await saveRef.current();
    if (!saved) return;
    const childId = `${wfId}--${funcEl.id}`;
    const incomingEvents = flow
      .filter(([, to]) => to === funcEl.id)
      .map(([from]) => elements.find(e => e.id === from))
      .filter(e => e?.type === 'event') as WorkflowElement[];
    const outgoingEvents = flow
      .filter(([from]) => from === funcEl.id)
      .map(([, to]) => elements.find(e => e.id === to))
      .filter(e => e?.type === 'event') as WorkflowElement[];
    let freshList = await api.workflows.list().catch(() => workflows);
    if (!freshList.find(w => w.id === childId)) {
      const childEls: WorkflowElement[] = [];
      incomingEvents.forEach((ev, i) => {
        childEls.push({ ...ev, id: `start-${i + 1}`, locked: true, x: 40, y: snap(40 + i * (EH + 80)) });
      });
      outgoingEvents.forEach((ev, i) => {
        childEls.push({ ...ev, id: `end-${i + 1}`, locked: true, x: 600, y: snap(40 + i * (EH + 80)) });
      });
      try {
        await api.workflows.create({ id: childId, name: funcEl.label, version: '1.0.0', elements: childEls, flow: [], parent_id: wfId, parent_function_id: funcEl.id } as unknown as Workflow, true);
      } catch { /* may already exist */ }
      freshList = await api.workflows.list().catch(() => freshList);
      setWorkflows(freshList);
    }
    const newCrumb = [...breadcrumb, { id: wfId, name: wfName }];
    const childWf = freshList.find(w => w.id === childId);
    if (!childWf) { setError(`Не удалось создать под-процесс ${childId}`); return; }
    setWfId(childWf.id); setWfName(childWf.name || childWf.id);
    setElements([...childWf.elements]); setFlow([...(childWf.flow || [])]);
    setSelected(null); setMultiSelected([]); setConnectFrom(null); setMode('select');
    const pos: Record<string, Pos> = {};
    childWf.elements.forEach((el, i) => {
      if (typeof el.x === 'number' && typeof el.y === 'number' && (el.x !== 0 || el.y !== 0)) {
        pos[el.id] = { x: el.x, y: el.y };
      } else {
        const col = i % 6, row = Math.floor(i / 6);
        pos[el.id] = { x: snap(40 + col * (EW + 60)), y: snap(40 + row * (EH + 80)) };
      }
    });
    setPositions(pos);
    setBreadcrumb(newCrumb);
  }

  // ── Save ──────────────────────────────────────────────────────────────────────
  async function save(): Promise<boolean> {
    const name = wfName.trim();
    if (!name) { setError('Введите название процесса'); startCreatingNew(); return false; }
    let id = wfId.trim();
    if (!id) { id = slugify(name) || `process-${Date.now().toString(36)}`; setWfId(id); }
    setSaving(true); setError(null); setDraftWarning(null);
    try {
      const fresh = await api.workflows.list().catch(() => workflows);
      const exists = fresh.find(w => w.id === id);
      const elementsWithPos = elements.map(el => ({ ...el, x: positions[el.id]?.x ?? 0, y: positions[el.id]?.y ?? 0 }));
      const body = { id, name, elements: elementsWithPos, flow, ...(exists ? {} : { version: '1.0.0' }) } as unknown as Workflow;
      let savedAsDraft = false, validationMsg: string | null = null;
      try {
        if (exists) await api.workflows.update(id, body, false);
        else        await api.workflows.create(body, false);
      } catch (validationErr: any) {
        validationMsg = validationErr.message ?? null;
        if (exists) await api.workflows.update(id, body, true);
        else        await api.workflows.create(body, true);
        savedAsDraft = true;
      }
      refreshList();
      if (savedAsDraft) {
        const details = validationMsg ? validationMsg.split('\n').map(s => s.trim()).filter(Boolean) : [];
        setDraftWarning({ text: 'Процесс сохранён как черновик — схема некорректна, недоступна для запуска', details });
      }
    } catch (err: any) { setError(err.message); setSaving(false); return false; }
    setSaving(false);
    return true;
  }

  // Keep saveRef current
  saveRef.current = save;
  panXRef.current = panX; panYRef.current = panY; zoomRef.current = zoom;

  // ── Process mining ────────────────────────────────────────────────────────────
  async function toggleMining() {
    if (showMining) { setShowMining(false); return; }
    if (!wfId.trim()) return;
    setShowMining(true); setMiningLoading(true);
    try {
      const data = await api.mining.process(wfId.trim());
      setMiningData(data);
    } catch { setMiningData(null); }
    finally { setMiningLoading(false); }
  }

  // ── Sync role/doc entity on inline edit ──────────────────────────────────────
  function syncEntityOnEdit(el: WorkflowElement, newLabel: string) {
    if (el.type === 'role') {
      const refId = el.ref_id;
      if (!refId) {
        api.roles.create({ role_id: newLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now(), name: newLabel, assignees: [], strategy: 'manual' })
          .then(r => { updateElement(el.id, { ref_id: r.role_id }); setRoles(prev => [...prev, r]); })
          .catch(() => {});
      } else {
        const existing = roles.find(r => r.role_id === refId);
        if (existing && existing.name !== newLabel) {
          api.roles.update(refId, { name: newLabel }).catch(() => {});
          setRoles(prev => prev.map(r => r.role_id === refId ? { ...r, name: newLabel } : r));
        }
      }
    } else if (el.type === 'document') {
      const refId = el.ref_id;
      if (!refId) {
        api.documents.create({ name: newLabel, type: 'template', content: '' })
          .then(d => { updateElement(el.id, { ref_id: d.doc_id }); setDocs(prev => [...prev, d]); })
          .catch(() => {});
      } else {
        const existing = docs.find(d => d.doc_id === refId);
        if (existing && existing.name !== newLabel) {
          api.documents.update(refId, { name: newLabel }).catch(() => {});
          setDocs(prev => prev.map(d => d.doc_id === refId ? { ...d, name: newLabel } : d));
        }
      }
    }
  }

  // ── Derived values ────────────────────────────────────────────────────────────
  const selEl = elements.find(e => e.id === selected);
  const canvasCursor = connectDrag ? 'crosshair' : mode === 'connect' ? 'crosshair'
    : (dragging || groupDrag) ? 'grabbing' : 'default';
  const operatorWorkflows = filterOperatorWorkflows(workflows, { showHiddenArtifacts });
  const hiddenWorkflowCount = workflows.length - operatorWorkflows.length;
  const filteredWorkflows = sideSearch.trim()
    ? operatorWorkflows.filter(w => (w.name || w.id).toLowerCase().includes(sideSearch.toLowerCase()))
    : operatorWorkflows;
  const isKnown = workflows.some(w => w.id === wfId.trim());

  function buildTree(wfs: Workflow[]): WfNode[] {
    const map = new Map<string, WfNode>(wfs.map(w => [w.id, { ...w, children: [] }]));
    const roots: WfNode[] = [];
    for (const node of map.values()) {
      const pid = node.parent_id;
      if (pid && map.has(pid)) map.get(pid)!.children.push(node);
      else roots.push(node);
    }
    return roots;
  }
  const workflowTree = sideSearch.trim() ? [] : buildTree(operatorWorkflows);

  return {
    // identity
    token, wfId, wfName, isKnown,
    // canvas
    elements, positions, flow,
    selected, multiSelected, connectFrom, mode,
    dragging, groupDrag, marquee, hoveredEl, setHoveredEl, connectDrag,
    editingId, editingValue, setEditingId, setEditingValue,
    gatewayPickerId, setGatewayPickerId,
    panX, panY, zoom,
    // ui
    error, saving, draftWarning, autosavePending,
    workflows, operatorWorkflows, hiddenWorkflowCount, showHiddenArtifacts, setShowHiddenArtifacts,
    sideW, versions, viewingVersion, setViewingVersion,
    roles, docs, adapters, wsFiles, breadcrumb,
    showChat, setShowChat, picker, setPicker,
    triggerResolving, resolveTrigger,
    sideSearch, setSideSearch,
    creatingNew, setCreatingNew, newProcName, setNewProcName,
    renamingWfId, renamingVal, setRenamingVal,
    collapsedTree, setCollapsedTree,
    showMining, miningData, miningLoading,
    // refs
    svgRef,
    // derived
    selEl, canvasCursor, filteredWorkflows, workflowTree,
    // handlers
    save, undo, redo, undoStack, redoStack,
    zoomIn, zoomOut, zoomReset, zoomFit,
    refreshList, newProcess, startCreatingNew, commitNewProc,
    startRename, commitRename, dupWorkflow, delWorkflow,
    loadWorkflow, drillDown, toggleMining, applyTsunadePatch,
    addElement, paletteClick, pickFromRegistry, deleteElement, updateElement, removeEdge, applyPatch,
    switchMode, scheduleAutosave, syncEntityOnEdit,
    onResizeMouseDown,
    onElMouseDown, onSvgMouseDown, onSvgMouseMove, onSvgMouseUp, onElMouseUp, onSvgClick,
    setElements, setPositions, setFlow, setSelected, setMultiSelected, setConnectDrag,
  };
}
