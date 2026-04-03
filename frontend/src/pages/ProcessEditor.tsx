/**
 * ProcessEditor — interactive visual eEPC process editor
 * Drag elements from palette, connect with arrows, save to API.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { api } from '../api/client';
import type { Workflow, WorkflowElement, RoleDef, DocTemplate } from '../api/types';

type EType = WorkflowElement['type'];
type Pos = { x: number; y: number };
type Mode = 'select' | 'connect';

// ── Canvas constants ──────────────────────────────────────────────────────────
const EW = 160;   // element width
const EH = 58;    // element height
const GR = 24;    // gateway radius
const HD = 20;    // hexagon indent (event)
const CW = 1600;  // canvas width
const CH = 960;   // canvas height

// ── Element type palette ──────────────────────────────────────────────────────
const PALETTE: { type: EType; label: string; fill: string; stroke: string }[] = [
  { type: 'event',              label: 'Событие',  fill: '#F5C4B3', stroke: '#993C1D' },
  { type: 'function',           label: 'Функция',  fill: '#C0DD97', stroke: '#3B6D11' },
  { type: 'gateway',            label: 'Шлюз',     fill: '#E8F4FD', stroke: '#4B7BA8' },
  { type: 'role',               label: 'Роль',     fill: '#FFF9C4', stroke: '#B7A000' },
  { type: 'document',           label: 'Документ', fill: '#DBEAFE', stroke: '#3B82F6' },
  { type: 'information_system', label: 'IS',       fill: '#E0F2FE', stroke: '#0EA5E9' },
];

const DEFAULT_LABELS: Record<EType, string> = {
  event:              'Новое событие',
  function:           'Новая функция',
  gateway:            'Новый шлюз',
  role:               'Новая роль',
  document:           'Новый документ',
  information_system: 'Новая ИС',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function genId(type: EType, els: WorkflowElement[]): string {
  const p = type.replace('_', '-');
  const nums = els.filter(e => e.id.startsWith(p + '-'))
    .map(e => parseInt(e.id.split('-').pop() || '0', 10));
  return `${p}-${nums.length ? Math.max(...nums) + 1 : 1}`;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const CORNER_R = 10;

function routeVHV(x1: number, y1: number, x2: number, y2: number, midY: number): string {
  if (Math.abs(x1 - x2) < 0.5) return `M${x1},${y1} L${x2},${y2}`;
  const dy1 = midY - y1, dx = x2 - x1, dy2 = y2 - midY;
  const r1 = Math.min(CORNER_R, Math.abs(dy1) / 2, Math.abs(dx) / 2);
  const r2 = Math.min(CORNER_R, Math.abs(dx) / 2, Math.abs(dy2) / 2);
  const s1 = dy1 >= 0 ? 1 : -1, sx = dx >= 0 ? 1 : -1, s2 = dy2 >= 0 ? 1 : -1;
  return [
    `M${x1},${y1}`,
    `L${x1},${midY - s1 * r1}`,
    `Q${x1},${midY} ${x1 + sx * r1},${midY}`,
    `L${x2 - sx * r2},${midY}`,
    `Q${x2},${midY} ${x2},${midY + s2 * r2}`,
    `L${x2},${y2}`,
  ].join(' ');
}

function routeHVH(x1: number, y1: number, x2: number, y2: number, midX: number): string {
  if (Math.abs(y1 - y2) < 0.5) return `M${x1},${y1} L${x2},${y2}`;
  const dx1 = midX - x1, dy = y2 - y1, dx2 = x2 - midX;
  const r1 = Math.min(CORNER_R, Math.abs(dx1) / 2, Math.abs(dy) / 2);
  const r2 = Math.min(CORNER_R, Math.abs(dy) / 2, Math.abs(dx2) / 2);
  const sx1 = dx1 >= 0 ? 1 : -1, sy = dy >= 0 ? 1 : -1, sx2 = dx2 >= 0 ? 1 : -1;
  return [
    `M${x1},${y1}`,
    `L${midX - sx1 * r1},${y1}`,
    `Q${midX},${y1} ${midX},${y1 + sy * r1}`,
    `L${midX},${y2 - sy * r2}`,
    `Q${midX},${y2} ${midX + sx2 * r2},${y2}`,
    `L${x2},${y2}`,
  ].join(' ');
}

function orthogonalPath(fp: Pos, tp: Pos): string {
  const fcx = fp.x + EW / 2, fcy = fp.y + EH / 2;
  const tcx = tp.x + EW / 2, tcy = tp.y + EH / 2;
  const dx = tcx - fcx, dy = tcy - fcy;
  if (Math.abs(dy) >= Math.abs(dx)) {
    const goDown = dy >= 0;
    const x1 = fcx, y1 = goDown ? fp.y + EH : fp.y;
    const x2 = tcx, y2 = goDown ? tp.y       : tp.y + EH;
    return routeVHV(x1, y1, x2, y2, (y1 + y2) / 2);
  } else {
    const goRight = dx >= 0;
    const x1 = goRight ? fp.x + EW : fp.x, y1 = fcy;
    const x2 = goRight ? tp.x       : tp.x + EW, y2 = tcy;
    return routeHVH(x1, y1, x2, y2, (x1 + x2) / 2);
  }
}

function snap(v: number, g = 20): number { return Math.round(v / g) * g; }

// ── Element shape SVG ─────────────────────────────────────────────────────────
interface ShapeProps { el: WorkflowElement; selected: boolean; connectSrc: boolean }
function ElShape({ el, selected, connectSrc, isEditing }: ShapeProps & { isEditing?: boolean }) {
  const pt = PALETTE.find(p => p.type === el.type);
  const fill  = pt?.fill   || '#f3f4f6';
  const str   = pt?.stroke || '#9ca3af';
  const sw    = selected || connectSrc ? 2.5 : 1.5;
  const outln = selected ? '#6366f1' : connectSrc ? '#f59e0b' : str;

  let shape: React.ReactNode;
  switch (el.type) {
    case 'event':
      shape = <polygon points={`${HD},0 ${EW-HD},0 ${EW},${EH/2} ${EW-HD},${EH} ${HD},${EH} 0,${EH/2}`} fill={fill} stroke={outln} strokeWidth={sw} />;
      break;
    case 'function':
      shape = <rect width={EW} height={EH} rx={10} fill={fill} stroke={outln} strokeWidth={sw} />;
      break;
    case 'gateway':
      shape = <circle cx={EW/2} cy={EH/2} r={GR} fill={fill} stroke={outln} strokeWidth={sw} />;
      break;
    case 'role':
      shape = <ellipse cx={EW/2} cy={EH/2} rx={EW/2-2} ry={EH/2-2} fill={fill} stroke={outln} strokeWidth={sw} />;
      break;
    case 'document': {
      const wave = `M0,${EH-10} Q${EW/4},${EH+4} ${EW/2},${EH-10} Q${3*EW/4},${EH-24} ${EW},${EH-10} L${EW},0 L0,0 Z`;
      shape = <path d={wave} fill={fill} stroke={outln} strokeWidth={sw} />;
      break;
    }
    default:
      shape = <rect width={EW} height={EH} fill={fill} stroke={outln} strokeWidth={sw} />;
  }

  const label = el.type === 'gateway' ? (el.operator || el.label) : el.label;
  const maxW = el.type === 'gateway' ? GR * 2 - 8 : EW - 16;
  const words = String(label).split(' ');
  const charW = 6.2;
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const cand = cur ? cur + ' ' + w : w;
    if (cand.length * charW > maxW && cur) { lines.push(cur); cur = w; }
    else cur = cand;
  }
  if (cur) lines.push(cur);
  const lineH = 14;
  const startY = EH / 2 - ((lines.length - 1) * lineH) / 2;

  return (
    <>
      {shape}
      {!isEditing && lines.map((line, i) => (
        <text key={i} x={EW/2} y={startY + i * lineH}
          textAnchor="middle" dominantBaseline="middle"
          fontSize={12} fontFamily="system-ui,-apple-system,sans-serif"
          fill="#1a1a1a" pointerEvents="none">
          {line}
        </text>
      ))}
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const CSS = `
  .ipe-root { display:flex; flex-direction:column; height:calc(100vh - 64px); overflow:hidden; background:#e2e8f0; }
  .ipe-bar { display:flex; gap:8px; align-items:center; padding:8px 14px; background:#1e293b; color:white; flex-shrink:0; flex-wrap:wrap; }
  .ipe-bar .sep { width:1px; height:22px; background:#475569; flex-shrink:0; }
  .ipe-bar button { padding:5px 12px; border:1px solid #475569; background:#334155; color:white; border-radius:4px; cursor:pointer; font-size:12px; font-weight:500; white-space:nowrap; }
  .ipe-bar button:hover { background:#475569; }
  .ipe-bar button.active { background:#6366f1; border-color:#6366f1; }
  .ipe-bar button.btn-save { background:#16a34a; border-color:#16a34a; }
  .ipe-bar button.btn-save:hover { background:#15803d; }
  .ipe-bar .hint { font-size:11px; color:#fbbf24; }
  .ipe-body { display:flex; flex:1; overflow:hidden; }
  .ipe-side { flex-shrink:0; background:white; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:14px; min-width:160px; max-width:480px; }
  .ipe-side h3 { font-size:10px; font-weight:700; color:#64748b; text-transform:uppercase; margin:0 0 6px; letter-spacing:.05em; }
  .ipe-resize { width:5px; flex-shrink:0; cursor:col-resize; background:#e2e8f0; transition:background .15s; z-index:10; }
  .ipe-resize:hover, .ipe-resize.dragging { background:#94a3b8; }
  .pal-item { display:flex; align-items:center; gap:8px; padding:7px 10px; border:1px solid #e2e8f0; border-radius:6px; cursor:pointer; font-size:13px; user-select:none; }
  .pal-item:hover { background:#eff6ff; border-color:#bfdbfe; }
  .pal-dot { width:13px; height:13px; border-radius:3px; flex-shrink:0; }
  .props-field { display:flex; flex-direction:column; gap:3px; margin-bottom:8px; }
  .props-field label { font-size:10px; font-weight:700; color:#64748b; text-transform:uppercase; }
  .props-field input,.props-field select { padding:5px 8px; border:1px solid #ddd; border-radius:4px; font-size:12px; font-family:inherit; width:100%; box-sizing:border-box; }
  .edge-item { display:flex; align-items:center; gap:4px; font-size:11px; padding:2px 0; font-family:monospace; }
  .edge-del { background:none; border:none; color:#ef4444; cursor:pointer; font-size:14px; padding:0 2px; flex-shrink:0; }
  .ipe-canvas { flex:1; overflow:auto; }
  .ipe-canvas svg { display:block; }
  .error-bar { background:#fee; color:#c33; padding:6px 10px; font-size:12px; border-left:3px solid #c33; }
  .btn-del-el { width:100%; padding:5px; font-size:12px; background:#ef4444; color:white; border:none; border-radius:4px; cursor:pointer; margin-top:6px; }
  .load-divider { border:none; border-top:1px solid #e2e8f0; margin:4px 0 10px; }
  /* Process list */
  .proc-search { width:100%; padding:5px 8px; border:1px solid #ddd; border-radius:4px; font-size:12px; box-sizing:border-box; margin-bottom:6px; }
  .proc-new-row { display:flex; justify-content:space-between; align-items:center; margin-bottom:5px; }
  .btn-proc-new { padding:3px 9px; background:#6366f1; color:white; border:none; border-radius:4px; cursor:pointer; font-size:11px; font-weight:600; }
  .btn-proc-new:hover { background:#4f46e5; }
  .proc-list { max-height:200px; overflow-y:auto; display:flex; flex-direction:column; gap:2px; margin-bottom:4px; }
  .proc-item { display:flex; align-items:center; gap:4px; padding:5px 8px; border:1px solid #e2e8f0; border-radius:4px; cursor:pointer; font-size:12px; }
  .proc-item:hover { background:#eff6ff; border-color:#bfdbfe; }
  .proc-item.active { background:#eff6ff; border-color:#6366f1; font-weight:600; }
  .proc-item-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .proc-row-acts { display:none; gap:2px; }
  .proc-item:hover .proc-row-acts { display:flex; }
  .proc-row-acts button { padding:1px 4px; font-size:11px; border:1px solid #ddd; background:white; border-radius:3px; cursor:pointer; line-height:1.4; }
  .proc-row-acts button:hover { background:#f0f0f0; }
  .proc-row-acts .del-btn { color:#ef4444; border-color:#fca5a5; }
  .proc-new-input { width:100%; padding:5px 8px; border:1px solid #6366f1; border-radius:4px; font-size:12px; box-sizing:border-box; outline:none; }
  .proc-rename-input { flex:1; padding:2px 5px; border:1px solid #6366f1; border-radius:3px; font-size:12px; outline:none; min-width:0; }
  /* Picker */
  .picker-overlay { position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:200; display:flex; align-items:center; justify-content:center; }
  .picker-box { background:white; border-radius:8px; padding:18px; width:340px; max-height:70vh; display:flex; flex-direction:column; box-shadow:0 20px 40px rgba(0,0,0,.2); }
  .picker-box h3 { font-size:14px; font-weight:700; margin-bottom:12px; }
  .picker-list { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:4px; margin-bottom:12px; }
  .picker-item { padding:8px 12px; border:1px solid #e2e8f0; border-radius:6px; cursor:pointer; font-size:13px; }
  .picker-item:hover { background:#eff6ff; border-color:#bfdbfe; }
  .picker-footer { display:flex; gap:8px; }
  .picker-footer button { flex:1; padding:7px; border:none; border-radius:4px; cursor:pointer; font-size:13px; }
  .picker-footer .btn-custom { background:#0066cc; color:white; }
  .picker-footer .btn-cancel { background:#e5e7eb; color:#374151; }
`;

// ── Main component ────────────────────────────────────────────────────────────
export function ProcessEditor() {
  const token = useToken();
  const [wfId,   setWfId]   = useState('');
  const [wfName, setWfName] = useState('');
  const [elements, setElements] = useState<WorkflowElement[]>([]);
  const [positions, setPositions] = useState<Record<string, Pos>>({});
  const [flow, setFlow] = useState<[string, string, string?][]>([]);
  const [selected,    setSelected]    = useState<string | null>(null);
  const [multiSelected, setMultiSelected] = useState<string[]>([]);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
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
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [sideW,   setSideW]   = useState(240);
  const [roles,    setRoles]    = useState<RoleDef[]>([]);
  const [docs,     setDocs]     = useState<DocTemplate[]>([]);
  const [adapters, setAdapters] = useState<string[]>([]);
  const [picker,   setPicker]   = useState<'role' | 'document' | 'is' | null>(null);
  // Sidebar state
  const [sideSearch,    setSideSearch]    = useState('');
  const [creatingNew,   setCreatingNew]   = useState(false);
  const [newProcName,   setNewProcName]   = useState('');
  const [renamingWfId,  setRenamingWfId]  = useState<string | null>(null);
  const [renamingVal,   setRenamingVal]   = useState('');
  const svgRef    = useRef<SVGSVGElement>(null);
  const resizing  = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartW = useRef(240);

  // ── Load workflow list + registries ────────────────────────────────────────
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
  }, [token]);

  // ── Process library CRUD ────────────────────────────────────────────────────
  function newProcess() {
    setWfId(''); setWfName(''); setElements([]); setFlow([]); setPositions({});
    setSelected(null); setMultiSelected([]); setConnectFrom(null); setMode('select'); setError(null);
  }

  function startCreatingNew() {
    setCreatingNew(true); setNewProcName('');
  }

  function commitNewProc() {
    const name = newProcName.trim();
    setCreatingNew(false); setNewProcName('');
    if (!name) return;
    const id = slugify(name) || `process-${Date.now().toString(36)}`;
    setWfId(id); setWfName(name); setElements([]); setFlow([]); setPositions({});
    setSelected(null); setMultiSelected([]); setConnectFrom(null); setMode('select'); setError(null);
  }

  function startRename(wf: Workflow) {
    setRenamingWfId(wf.id);
    setRenamingVal(wf.name || wf.id);
  }

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
    const newId = `${wf.id}-copy`;
    const newName = `${wf.name || wf.id} (копия)`;
    try {
      await api.workflows.create({ ...wf, id: newId, name: newName } as unknown as Workflow);
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

  // ── Keyboard delete ─────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const toDelete = multiSelected.length > 0 ? multiSelected : selected ? [selected] : [];
      toDelete.forEach(id => deleteElement(id));
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [selected, multiSelected]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sidebar resize ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      const delta = e.clientX - resizeStartX.current;
      setSideW(Math.max(160, Math.min(480, resizeStartW.current + delta)));
    };
    const onUp = () => { resizing.current = false; };
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

  // ── Element management ──────────────────────────────────────────────────────
  function addElement(type: EType, label?: string, refId?: string) {
    const id  = genId(type, elements);
    const idx = elements.length;
    const col = idx % 6, row = Math.floor(idx / 6);
    const pos: Pos = { x: snap(40 + col * (EW + 60)), y: snap(40 + row * (EH + 80)) };
    const el: WorkflowElement = { id, type, label: label || DEFAULT_LABELS[type] || type };
    if (type === 'gateway') el.operator = 'AND';
    if (refId) (el as any).ref_id = refId;
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
    setElements(prev => prev.filter(e => e.id !== id));
    setFlow(prev => prev.filter(([f, t]) => f !== id && t !== id));
    setPositions(prev => { const n = { ...prev }; delete n[id]; return n; });
    if (selected === id) setSelected(null);
    setMultiSelected(prev => prev.filter(i => i !== id));
    setConnectFrom(null);
  }

  function updateElement(id: string, patch: Partial<WorkflowElement>) {
    setElements(prev => prev.map(e => e.id === id ? { ...e, ...patch } : e));
  }

  function removeEdge(f: string, t: string) {
    setFlow(prev => prev.filter(([a, b]) => !(a === f && b === t)));
  }

  // ── SVG mouse helpers ───────────────────────────────────────────────────────
  function svgCoords(e: React.MouseEvent): Pos {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ── Element interaction ─────────────────────────────────────────────────────
  function onElMouseDown(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    e.preventDefault();

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

    // Group drag if element is part of multi-selection
    if (multiSelected.length > 1 && multiSelected.includes(id)) {
      const startPos: Record<string, Pos> = {};
      multiSelected.forEach(sid => { startPos[sid] = positions[sid] || { x: 0, y: 0 }; });
      setGroupDrag({ ids: multiSelected, startPos, mx: pt.x, my: pt.y });
      return;
    }

    // Single drag
    const pos = positions[id] || { x: 0, y: 0 };
    setDragging({ id, ox: pos.x, oy: pos.y, mx: pt.x, my: pt.y });
    setSelected(id); setMultiSelected([id]);
  }

  function onSvgMouseDown(e: React.MouseEvent) {
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
    if (connectDrag) {
      setConnectDrag(prev => prev ? { ...prev, curX: pt.x, curY: pt.y } : null);
    }
    if (marquee) {
      setMarquee(prev => prev ? { ...prev, ex: pt.x, ey: pt.y } : null);
    }
  }

  function onSvgMouseUp() {
    setDragging(null);
    setGroupDrag(null);
    setConnectDrag(null);
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
      }
      setMarquee(null);
    }
  }

  function onElMouseUp(e: React.MouseEvent, toId: string) {
    if (!connectDrag || connectDrag.fromId === toId) return;
    e.stopPropagation();
    const fromId = connectDrag.fromId;
    if (!flow.some(([f, t]) => f === fromId && t === toId)) {
      setFlow(prev => [...prev, [fromId, toId]]);
    }
    const srcEl = elements.find(el => el.id === fromId);
    const dstEl = elements.find(el => el.id === toId);
    if (srcEl?.type === 'role' && dstEl?.type === 'function') updateElement(dstEl.id, { role: srcEl.label });
    else if (srcEl?.type === 'function' && dstEl?.type === 'role') updateElement(srcEl.id, { role: dstEl.label });
    setConnectDrag(null);
  }

  function onSvgClick() {
    if (mode === 'connect' && connectFrom) {
      setConnectFrom(null);
    } else if (!marquee) {
      setSelected(null); setMultiSelected([]);
    }
  }

  function switchMode(m: Mode) {
    setMode(m); setConnectFrom(null);
    if (m === 'connect') { setSelected(null); setMultiSelected([]); }
  }

  // ── Save ────────────────────────────────────────────────────────────────────
  async function save(draft = false) {
    const name = wfName.trim();
    if (!name) { setError('Введите название процесса'); return; }
    let id = wfId.trim();
    if (!id) {
      id = slugify(name) || `process-${Date.now().toString(36)}`;
      setWfId(id);
    }
    setSaving(true); setError(null);
    try {
      const fresh = await api.workflows.list().catch(() => workflows);
      const exists = fresh.find(w => w.id === id);
      const body = { id, name, elements, flow, ...(exists ? {} : { version: '1.0.0' }) } as unknown as Workflow;
      if (exists) await api.workflows.update(id, body, draft);
      else        await api.workflows.create(body, draft);
      refreshList();
    } catch (err: any) { setError(err.message); }
    setSaving(false);
  }

  const isKnown = workflows.some(w => w.id === wfId.trim());

  function loadWorkflow(id: string) {
    const wf = workflows.find(w => w.id === id);
    if (!wf) return;
    setWfId(wf.id); setWfName(wf.name || wf.id);
    setElements([...wf.elements]); setFlow([...(wf.flow || [])]);
    setSelected(null); setMultiSelected([]); setConnectFrom(null); setMode('select');
    const pos: Record<string, Pos> = {};
    wf.elements.forEach((el, i) => {
      const col = i % 6, row = Math.floor(i / 6);
      pos[el.id] = { x: snap(40 + col * (EW + 60)), y: snap(40 + row * (EH + 80)) };
    });
    setPositions(pos);
  }

  // ── Derived ─────────────────────────────────────────────────────────────────
  const selEl = elements.find(e => e.id === selected);
  const canvasCursor = connectDrag ? 'crosshair' : mode === 'connect' ? 'crosshair'
    : (dragging || groupDrag) ? 'grabbing' : 'default';
  const filteredWorkflows = sideSearch.trim()
    ? workflows.filter(w => (w.name || w.id).toLowerCase().includes(sideSearch.toLowerCase()))
    : workflows;

  return (
    <Layout activePage="editor.html">
      <style>{CSS}</style>
      <div className="ipe-root">

        {/* ── Toolbar ── */}
        <div className="ipe-bar">
          <span style={{ color: '#94a3b8', fontSize: 12, flexShrink: 0 }}>Редактор процессов</span>
          {wfName && (
            <>
              <div className="sep" />
              <span style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 500, flexShrink: 0, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {wfName}
              </span>
            </>
          )}
          <div className="sep" />
          <button
            className={mode === 'select' ? 'active' : ''}
            onClick={() => switchMode('select')}
            title="Выбор и перемещение элементов">
            ↖ Выбор
          </button>
          <button
            className={mode === 'connect' ? 'active' : ''}
            onClick={() => switchMode(mode === 'connect' ? 'select' : 'connect')}
            title="Рисовать связи между элементами">
            ⟶ Связь
          </button>
          <div className="sep" />
          <button className="btn-save" onClick={() => save(false)} disabled={saving}>
            {saving ? 'Сохранение…' : isKnown ? '💾 Обновить' : '💾 Сохранить'}
          </button>
          <button onClick={() => save(true)} disabled={saving}
            title="Сохранить без валидации как черновик" style={{ opacity: 0.8 }}>
            📝 Черновик
          </button>
          {error && <span style={{ color: '#fca5a5', fontSize: 12 }}>{error}</span>}
          {mode === 'connect' && (
            <span className="hint">
              {connectFrom
                ? `Источник: ${connectFrom} — кликните целевой элемент`
                : 'Кликните исходный элемент…'}
            </span>
          )}
        </div>

        <div className="ipe-body">

          {/* ── Sidebar ── */}
          <div className="ipe-side" style={{ width: sideW }}>

            {/* Process library */}
            <div>
              <div className="proc-new-row">
                <h3 style={{ margin: 0 }}>Процессы</h3>
                <button className="btn-proc-new" onClick={startCreatingNew}>+ Новый</button>
              </div>
              {/* Search */}
              <input
                className="proc-search"
                placeholder="Поиск по названию…"
                value={sideSearch}
                onChange={e => setSideSearch(e.target.value)}
              />
              {/* Inline new process input */}
              {creatingNew && (
                <input
                  className="proc-new-input"
                  autoFocus
                  placeholder="Название нового процесса…"
                  value={newProcName}
                  onChange={e => setNewProcName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitNewProc();
                    if (e.key === 'Escape') { setCreatingNew(false); setNewProcName(''); }
                  }}
                  onBlur={() => { if (!newProcName.trim()) { setCreatingNew(false); setNewProcName(''); } else commitNewProc(); }}
                  style={{ marginBottom: 4 }}
                />
              )}
              <div className="proc-list">
                {filteredWorkflows.length === 0 && !creatingNew && (
                  <div style={{ fontSize: 11, color: '#94a3b8', padding: '4px 0' }}>Процессов пока нет</div>
                )}
                {filteredWorkflows.map(w => (
                  <div
                    key={w.id}
                    className={`proc-item${wfId === w.id ? ' active' : ''}`}
                    onClick={() => { if (renamingWfId !== w.id) loadWorkflow(w.id); }}
                    onDoubleClick={e => { e.stopPropagation(); startRename(w); }}
                    title={w.id}
                  >
                    {renamingWfId === w.id ? (
                      <input
                        className="proc-rename-input"
                        autoFocus
                        value={renamingVal}
                        onChange={e => setRenamingVal(e.target.value)}
                        onKeyDown={e => {
                          e.stopPropagation();
                          if (e.key === 'Enter') commitRename(w.id);
                          if (e.key === 'Escape') setRenamingWfId(null);
                        }}
                        onBlur={() => commitRename(w.id)}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <span className="proc-item-name">{w.name || w.id}</span>
                    )}
                    {renamingWfId !== w.id && (
                      <div className="proc-row-acts">
                        <button title="Дублировать" onClick={e => { e.stopPropagation(); dupWorkflow(w); }}>📋</button>
                        <button className="del-btn" title="Удалить" onClick={e => { e.stopPropagation(); delWorkflow(w); }}>🗑</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <hr className="load-divider" />
            </div>

            {/* Element palette */}
            <div>
              <h3>Добавить элемент</h3>
              {PALETTE.map(p => (
                <div key={p.type} className="pal-item" onClick={() => paletteClick(p.type)}>
                  <div className="pal-dot" style={{ background: p.fill, border: `1px solid ${p.stroke}` }} />
                  <span style={{ flex: 1 }}>{p.label}</span>
                  {(p.type === 'role' && roles.length > 0) ||
                   (p.type === 'document' && docs.length > 0) ||
                   (p.type === 'information_system' && adapters.length > 0)
                    ? <span style={{ fontSize: 10, color: '#94a3b8' }}>▾ pick</span>
                    : null}
                </div>
              ))}
            </div>

            {/* Properties panel */}
            {selEl && (
              <div>
                <h3>Свойства</h3>
                <div className="props-field">
                  <label>Название</label>
                  <input value={selEl.label} onChange={e => updateElement(selEl.id, { label: e.target.value })} />
                </div>
                {selEl.type === 'gateway' && (
                  <div className="props-field">
                    <label>Оператор</label>
                    <select value={selEl.operator || 'AND'} onChange={e => updateElement(selEl.id, { operator: e.target.value })}>
                      <option>AND</option><option>OR</option><option>XOR</option>
                    </select>
                  </div>
                )}
                {selEl.type === 'function' && (
                  <div className="props-field">
                    <label>Роль</label>
                    {roles.length > 0 ? (
                      <select value={selEl.role || ''} onChange={e => updateElement(selEl.id, { role: e.target.value || undefined })}>
                        <option value="">— нет —</option>
                        {roles.map(r => <option key={r.role_id} value={r.name}>{r.name}</option>)}
                        {selEl.role && !roles.some(r => r.name === selEl.role) &&
                          <option value={selEl.role}>{selEl.role}</option>}
                      </select>
                    ) : (
                      <input value={selEl.role || ''} placeholder="Назначенная роль…"
                        onChange={e => updateElement(selEl.id, { role: e.target.value || undefined })} />
                    )}
                  </div>
                )}
                <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace', marginBottom: 4 }}>{selEl.id}</div>
                <button className="btn-del-el" onClick={() => deleteElement(selEl.id)}>Удалить элемент</button>
              </div>
            )}

            {/* Connection list */}
            {flow.length > 0 && (
              <div>
                <h3>Связи ({flow.length})</h3>
                {flow.map(([f, t], i) => (
                  <div key={i} className="edge-item">
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f} → {t}</span>
                    <button className="edge-del" onClick={() => removeEdge(f, t)}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Resize handle ── */}
          <div className="ipe-resize" onMouseDown={onResizeMouseDown} title="Drag to resize panel" />

          {/* ── Canvas ── */}
          <div className="ipe-canvas">
            <svg
              ref={svgRef}
              width={CW} height={CH}
              style={{ cursor: canvasCursor }}
              onMouseDown={onSvgMouseDown}
              onMouseMove={onSvgMouseMove}
              onMouseUp={onSvgMouseUp}
              onMouseLeave={onSvgMouseUp}
              onClick={onSvgClick}
            >
              <defs>
                <pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse">
                  <circle cx="1" cy="1" r="1" fill="#cbd5e1" />
                </pattern>
                <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L8,3 z" fill="#6b7280" />
                </marker>
                <marker id="arr-hi" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L8,3 z" fill="#6366f1" />
                </marker>
              </defs>

              <rect width={CW} height={CH} fill="white" />
              <rect width={CW} height={CH} fill="url(#dots)" />

              {/* ── Edges ── */}
              {flow.map(([fId, tId], i) => {
                const fp = positions[fId], tp = positions[tId];
                if (!fp || !tp) return null;
                const d = orthogonalPath(fp, tp);
                const isHighlighted = selected === fId || selected === tId
                  || multiSelected.includes(fId) || multiSelected.includes(tId);
                const srcType = elements.find(e => e.id === fId)?.type;
                const dstType = elements.find(e => e.id === tId)?.type;
                const isRoleEdge = srcType === 'role' || dstType === 'role';
                const arrow = isRoleEdge ? undefined : isHighlighted ? 'url(#arr-hi)' : 'url(#arr)';
                return (
                  <g key={i}>
                    <path d={d} stroke={isHighlighted ? '#6366f1' : isRoleEdge ? '#B7A000' : '#6b7280'}
                      strokeWidth={isHighlighted ? 2 : 1.5} strokeDasharray={isRoleEdge ? '5 3' : undefined}
                      fill="none" markerEnd={arrow} />
                    <path d={d} stroke="transparent" strokeWidth={12} fill="none"
                      style={{ cursor: 'pointer' }}
                      onClick={e => { e.stopPropagation(); removeEdge(fId, tId); }} />
                  </g>
                );
              })}

              {/* ── Rubber-band connection line ── */}
              {connectDrag && (
                <line x1={connectDrag.startX} y1={connectDrag.startY}
                  x2={connectDrag.curX} y2={connectDrag.curY}
                  stroke="#6366f1" strokeWidth={1.5} strokeDasharray="6 3" pointerEvents="none" />
              )}

              {/* ── Marquee selection box ── */}
              {marquee && (() => {
                const x = Math.min(marquee.sx, marquee.ex);
                const y = Math.min(marquee.sy, marquee.ey);
                const w = Math.abs(marquee.ex - marquee.sx);
                const h = Math.abs(marquee.ey - marquee.sy);
                return (
                  <rect x={x} y={y} width={w} height={h}
                    fill="rgba(99,102,241,0.08)" stroke="#6366f1" strokeWidth={1.5}
                    strokeDasharray="4 2" pointerEvents="none" />
                );
              })()}

              {/* ── Elements ── */}
              {elements.map(el => {
                const pos = positions[el.id] || { x: 40, y: 40 };
                const isSel = selected === el.id || multiSelected.includes(el.id);
                const isCFrom = connectFrom === el.id;
                const elCursor = connectDrag ? 'crosshair'
                  : mode === 'select' ? ((dragging?.id === el.id || groupDrag?.ids.includes(el.id)) ? 'grabbing' : 'grab')
                  : 'pointer';
                const isEditingThis = editingId === el.id;
                const showAnchors = hoveredEl === el.id && mode === 'select' && !dragging && !groupDrag && !connectDrag && !marquee;
                return (
                  <g
                    key={el.id}
                    transform={`translate(${pos.x},${pos.y})`}
                    style={{ cursor: elCursor }}
                    onMouseEnter={() => setHoveredEl(el.id)}
                    onMouseLeave={() => setHoveredEl(null)}
                    onMouseDown={e => { if (isEditingThis) e.stopPropagation(); else onElMouseDown(e, el.id); }}
                    onMouseUp={e => onElMouseUp(e, el.id)}
                    onClick={e => e.stopPropagation()}
                    onDoubleClick={e => {
                      if (mode !== 'select') return;
                      e.stopPropagation();
                      const field = el.type === 'gateway' ? (el.operator ?? el.label) : el.label;
                      setEditingId(el.id);
                      setEditingValue(String(field ?? ''));
                    }}
                  >
                    <ElShape el={el} selected={isSel} connectSrc={isCFrom} isEditing={isEditingThis} />
                    {showAnchors && [
                      { ax: EW / 2, ay: 0 },
                      { ax: EW / 2, ay: EH },
                      { ax: 0,      ay: EH / 2 },
                      { ax: EW,     ay: EH / 2 },
                    ].map(({ ax, ay }, i) => (
                      <circle key={i} cx={ax} cy={ay} r={5}
                        fill="#6366f1" fillOpacity={0.85} stroke="white" strokeWidth={1.5}
                        style={{ cursor: 'crosshair' }}
                        onMouseDown={e2 => {
                          e2.stopPropagation(); e2.preventDefault();
                          const epos = positions[el.id] || { x: 0, y: 0 };
                          const sx = epos.x + ax, sy = epos.y + ay;
                          setConnectDrag({ fromId: el.id, startX: sx, startY: sy, curX: sx, curY: sy });
                        }}
                      />
                    ))}
                    {isEditingThis && (
                      <foreignObject x={4} y={EH / 2 - 13} width={EW - 8} height={26}>
                        <input
                          // @ts-ignore
                          xmlns="http://www.w3.org/1999/xhtml"
                          autoFocus
                          value={editingValue}
                          onChange={e2 => setEditingValue((e2.target as HTMLInputElement).value)}
                          onBlur={() => {
                            const v = editingValue.trim();
                            if (v) {
                              el.type === 'gateway'
                                ? updateElement(el.id, { operator: v, label: v })
                                : updateElement(el.id, { label: v });
                            }
                            setEditingId(null);
                          }}
                          onKeyDown={e2 => {
                            if (e2.key === 'Enter') { (e2.target as HTMLInputElement).blur(); }
                            if (e2.key === 'Escape') { setEditingId(null); }
                          }}
                          style={{
                            width: '100%', height: '100%', boxSizing: 'border-box',
                            background: 'white', border: '1.5px solid #6366f1', borderRadius: 4,
                            padding: '2px 6px', fontSize: 12, textAlign: 'center',
                            fontFamily: 'system-ui,-apple-system,sans-serif', outline: 'none',
                          }}
                        />
                      </foreignObject>
                    )}
                  </g>
                );
              })}

              {elements.length === 0 && (
                <text x={CW / 2} y={CH / 2} textAnchor="middle" dominantBaseline="middle"
                  fontSize={14} fill="#94a3b8" fontFamily="system-ui,-apple-system,sans-serif" pointerEvents="none">
                  Кликните элемент в палитре, чтобы добавить его на холст
                </text>
              )}
            </svg>
          </div>
        </div>
      </div>

      {/* ── Registry picker modal ── */}
      {picker && (
        <div className="picker-overlay" onClick={() => setPicker(null)}>
          <div className="picker-box" onClick={e => e.stopPropagation()}>
            <h3>
              {picker === 'role' ? '👤 Выбрать роль'
               : picker === 'document' ? '📄 Выбрать документ'
               : '🖥 Выбрать информационную систему'}
            </h3>
            <div className="picker-list">
              {picker === 'is'
                ? adapters.map(name => (
                    <div key={name} className="picker-item" onClick={() => pickFromRegistry(name, name)}>
                      <strong>{name}</strong>
                    </div>
                  ))
                : (picker === 'role' ? roles : docs).map(item => {
                    const id   = (item as any).role_id ?? (item as any).doc_id;
                    const name = (item as any).name;
                    return (
                      <div key={id} className="picker-item" onClick={() => pickFromRegistry(name, id)}>
                        <strong>{name}</strong>
                        {(item as any).description && (
                          <span style={{ color: '#64748b', fontSize: 11, marginLeft: 8 }}>
                            {(item as any).description}
                          </span>
                        )}
                      </div>
                    );
                  })}
            </div>
            <div className="picker-footer">
              <button className="btn-custom" onClick={() => { addElement(picker === 'is' ? 'information_system' : picker!); setPicker(null); }}>
                + Добавить своё
              </button>
              <button className="btn-cancel" onClick={() => setPicker(null)}>Отмена</button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
