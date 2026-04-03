/**
 * ProcessEditor — interactive visual eEPC process editor
 * Drag elements from palette, connect with arrows, save to API.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { api } from '../api/client';
import type { Workflow, WorkflowElement, RoleDef, DocTemplate, ProcessMiningData } from '../api/types';

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
  { type: 'gateway',            label: 'Ветвление', fill: '#E8F4FD', stroke: '#4B7BA8' },
  { type: 'role',               label: 'Роль',     fill: '#FFF9C4', stroke: '#B7A000' },
  { type: 'document',           label: 'Документ', fill: '#DBEAFE', stroke: '#3B82F6' },
  { type: 'information_system', label: 'IS',       fill: '#E0F2FE', stroke: '#0EA5E9' },
];

const DEFAULT_LABELS: Record<EType, string> = {
  event:              'Новое событие',
  function:           'Новая функция',
  gateway:            'Новое ветвление',
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

function orthogonalPath(fp: Pos, tp: Pos, fromType?: EType, toType?: EType): string {
  const fcx = fp.x + EW / 2, fcy = fp.y + EH / 2;
  const tcx = tp.x + EW / 2, tcy = tp.y + EH / 2;
  const dx = tcx - fcx, dy = tcy - fcy;
  const vert = Math.abs(dy) >= Math.abs(dx);

  let x1: number, y1: number, x2: number, y2: number;

  // Source exit point — snap to circle edge for gateways
  if (fromType === 'gateway') {
    if (vert) { x1 = fcx; y1 = fcy + (dy >= 0 ? GR : -GR); }
    else      { x1 = fcx + (dx >= 0 ? GR : -GR); y1 = fcy; }
  } else {
    if (vert) { x1 = fcx; y1 = dy >= 0 ? fp.y + EH : fp.y; }
    else      { x1 = dx >= 0 ? fp.x + EW : fp.x; y1 = fcy; }
  }

  // Target entry point — snap to circle edge for gateways
  if (toType === 'gateway') {
    if (vert) { x2 = tcx; y2 = tcy + (dy >= 0 ? -GR : GR); }
    else      { x2 = tcx + (dx >= 0 ? -GR : GR); y2 = tcy; }
  } else {
    if (vert) { x2 = tcx; y2 = dy >= 0 ? tp.y : tp.y + EH; }
    else      { x2 = dx >= 0 ? tp.x : tp.x + EW; y2 = tcy; }
  }

  return vert
    ? routeVHV(x1, y1, x2, y2, (y1 + y2) / 2)
    : routeHVH(x1, y1, x2, y2, (x1 + x2) / 2);
}

function snap(v: number, g = 20): number { return Math.round(v / g) * g; }

function pinchDist(touches: TouchList): number {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

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
  .ipe-canvas { flex:1; overflow:hidden; }
  .ipe-canvas svg { display:block; width:100%; height:100%; touch-action:none; }
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
  /* Tsunade chat panel */
  .tsunade-panel { width:320px; flex-shrink:0; display:flex; flex-direction:column; background:#0f172a; border-left:1px solid #1e293b; height:100%; }
  .tsunade-header { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid #1e293b; }
  .tsunade-title { font-size:13px; font-weight:600; color:#e2e8f0; }
  .tsunade-btn-close { background:none; border:none; color:#64748b; cursor:pointer; font-size:16px; padding:0 4px; line-height:1; }
  .tsunade-btn-close:hover { color:#94a3b8; }
  .tsunade-messages { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:10px; }
  .tsunade-msg { max-width:90%; padding:8px 10px; border-radius:8px; font-size:13px; line-height:1.5; }
  .tsunade-msg.user { align-self:flex-end; background:#334155; color:#e2e8f0; border-bottom-right-radius:2px; }
  .tsunade-msg.assistant { align-self:flex-start; background:#1e3a5f; color:#bfdbfe; border-bottom-left-radius:2px; }
  .tsunade-msg.system { align-self:center; background:#064e3b; color:#6ee7b7; font-size:11px; padding:4px 10px; border-radius:12px; }
  .tsunade-msg.error { align-self:center; background:#7f1d1d; color:#fca5a5; font-size:11px; padding:4px 10px; border-radius:12px; }
  .tsunade-input-row { display:flex; gap:6px; padding:10px 12px; border-top:1px solid #1e293b; }
  .tsunade-input { flex:1; background:#1e293b; border:1px solid #334155; border-radius:6px; color:#e2e8f0; font-size:13px; padding:7px 10px; outline:none; resize:none; font-family:inherit; }
  .tsunade-input:focus { border-color:#6366f1; }
  .tsunade-input::placeholder { color:#475569; }
  .tsunade-send { background:#6366f1; border:none; color:white; border-radius:6px; padding:7px 12px; cursor:pointer; font-size:13px; font-weight:600; flex-shrink:0; }
  .tsunade-send:hover { background:#4f46e5; }
  .tsunade-send:disabled { opacity:.5; cursor:not-allowed; }
  .btn-tsunade { background:#4f46e5 !important; border-color:#6366f1 !important; }
  .btn-tsunade:hover { background:#6366f1 !important; }
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
  /* Breadcrumb navigation */
  .ipe-breadcrumb { display:flex; align-items:center; gap:4px; font-size:12px; color:#94a3b8; flex-shrink:0; max-width:400px; overflow:hidden; }
  .ipe-breadcrumb a { color:#93c5fd; cursor:pointer; text-decoration:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:140px; display:inline-block; }
  .ipe-breadcrumb a:hover { color:#bfdbfe; text-decoration:underline; }
  .ipe-breadcrumb .bc-sep { color:#475569; flex-shrink:0; }
  .ipe-breadcrumb .bc-current { color:#e2e8f0; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:160px; display:inline-block; }
  /* Sub-process drill-down badge on function node */
  .drill-badge { cursor:pointer; opacity:0; transition:opacity .15s; }
  .drill-badge:hover { opacity:1 !important; }
  /* Process mining overlay */
  .mining-badge { pointer-events:none; font-family:system-ui,-apple-system,sans-serif; }
  /* Draft warning popover */
  .warn-wrap { position:relative; cursor:help; }
  .warn-pop { display:none; position:absolute; top:calc(100% + 6px); left:0; background:#1e293b; border:1px solid #fbbf24; border-radius:6px; padding:8px 12px; min-width:300px; max-width:460px; z-index:200; box-shadow:0 8px 24px rgba(0,0,0,.4); }
  .warn-wrap:hover .warn-pop { display:block; }
  .warn-pop ul { margin:0; padding:0 0 0 14px; }
  .warn-pop li { color:#fde68a; font-size:11px; line-height:1.6; }
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
  const [draftWarning, setDraftWarning] = useState<{ text: string; details: string[] } | null>(null);
  const [gatewayPickerId, setGatewayPickerId] = useState<string | null>(null);
  // Undo / redo
  type Snapshot = { els: WorkflowElement[]; fl: [string,string,string?][]; pos: Record<string,Pos> };
  const [undoStack, setUndoStack] = useState<Snapshot[]>([]);
  const [redoStack, setRedoStack] = useState<Snapshot[]>([]);
  // Autosave
  const [autosavePending, setAutosavePending] = useState(false);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [sideW,   setSideW]   = useState(240);
  const [roles,    setRoles]    = useState<RoleDef[]>([]);
  const [docs,     setDocs]     = useState<DocTemplate[]>([]);
  // Sub-process breadcrumb: stack of { id, name } from root to current
  const [breadcrumb, setBreadcrumb] = useState<{ id: string; name: string }[]>([]);
  const [adapters, setAdapters] = useState<string[]>([]);
  const [wsFiles,  setWsFiles]  = useState<string[]>([]);
  // Tsunade chat
  const [showChat,   setShowChat]   = useState(false);
  const [chatId,     setChatId]     = useState<string | null>(null);
  const [chatMsgs,   setChatMsgs]   = useState<{ role: 'user' | 'assistant' | 'system' | 'error'; text: string }[]>([]);
  const [chatInput,  setChatInput]  = useState('');
  const [chatBusy,   setChatBusy]   = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const [picker,   setPicker]   = useState<'role' | 'document' | 'is' | null>(null);
  // Sidebar state
  const [sideSearch,    setSideSearch]    = useState('');
  const [creatingNew,   setCreatingNew]   = useState(false);
  const [newProcName,   setNewProcName]   = useState('');
  const [renamingWfId,  setRenamingWfId]  = useState<string | null>(null);
  const [renamingVal,   setRenamingVal]   = useState('');
  // Pan / zoom
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [zoom, setZoom] = useState(1);
  // Process mining overlay
  const [showMining, setShowMining] = useState(false);
  const [miningData, setMiningData] = useState<ProcessMiningData | null>(null);
  const [miningLoading, setMiningLoading] = useState(false);

  const svgRef        = useRef<SVGSVGElement>(null);
  const resizing      = useRef(false);
  const resizeStartX  = useRef(0);
  const resizeStartW  = useRef(240);
  const justMarqueed  = useRef(false);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef       = useRef<() => Promise<void>>(async () => {});
  // Pan refs (capture at gesture start; used by global mousemove & touch handlers)
  const panStart      = useRef<{ cx: number; cy: number; px: number; py: number } | null>(null);
  const touchPinch    = useRef<{ dist: number; z: number } | null>(null);
  const panXRef       = useRef(0);
  const panYRef       = useRef(0);
  const zoomRef       = useRef(1);

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
    api.workspace.list().then(files => setWsFiles(files.map(f => f.name))).catch(() => {});
  }, [token]);

  // ── Process library CRUD ────────────────────────────────────────────────────
  function newProcess() {
    setWfId(''); setWfName(''); setElements([]); setFlow([]); setPositions({});
    setSelected(null); setMultiSelected([]); setConnectFrom(null); setMode('select'); setError(null);
    setBreadcrumb([]);
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
  const undoRef = useRef(undo); undoRef.current = undo;
  const redoRef = useRef(redo); redoRef.current = redo;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); undoRef.current(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); redoRef.current(); return; }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const toDelete = multiSelected.length > 0 ? multiSelected : selected ? [selected] : [];
      toDelete.forEach(id => deleteElement(id));
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [selected, multiSelected]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sidebar resize ──────────────────────────────────────────────────────────
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

  // ── Touch events (mobile pan + pinch zoom) ──────────────────────────────────
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        const target = e.target as Element;
        // Only pan on background touches (not on element shapes)
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

    function onTouchEnd() {
      panStart.current = null;
      touchPinch.current = null;
    }

    svg.addEventListener('touchstart', onTouchStart);
    svg.addEventListener('touchmove', onTouchMove, { passive: false });
    svg.addEventListener('touchend', onTouchEnd);
    return () => {
      svg.removeEventListener('touchstart', onTouchStart);
      svg.removeEventListener('touchmove', onTouchMove);
      svg.removeEventListener('touchend', onTouchEnd);
    };
  }, []); // refs used inside; no state deps needed

  // ── Element management ──────────────────────────────────────────────────────
  function addElement(type: EType, label?: string, refId?: string) {
    pushSnapshot(); scheduleAutosave();
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
    const el = elements.find(e => e.id === id);
    if (el?.locked) return; // locked boundary events in sub-processes cannot be deleted
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

  // ── SVG mouse helpers ───────────────────────────────────────────────────────
  function svgCoords(e: React.MouseEvent): Pos {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - panX) / zoom,
      y: (e.clientY - r.top  - panY) / zoom,
    };
  }

  // ── Element interaction ─────────────────────────────────────────────────────
  function onElMouseDown(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    e.preventDefault();
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
    if (e.button === 2) {
      // Right-click: start pan
      panStart.current = { cx: e.clientX, cy: e.clientY, px: panXRef.current, py: panYRef.current };
      e.preventDefault();
      return;
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
    if (connectDrag) {
      setConnectDrag(prev => prev ? { ...prev, curX: pt.x, curY: pt.y } : null);
    }
    if (marquee) {
      setMarquee(prev => prev ? { ...prev, ex: pt.x, ey: pt.y } : null);
    }
  }

  function onSvgMouseUp() {
    if (dragging || groupDrag) scheduleAutosave(); // positions changed by drag
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
        justMarqueed.current = true; // block the following click event from clearing selection
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
    if (mode === 'connect' && connectFrom) {
      setConnectFrom(null);
    } else {
      setSelected(null); setMultiSelected([]);
    }
  }

  function switchMode(m: Mode) {
    setMode(m); setConnectFrom(null);
    if (m === 'connect') { setSelected(null); setMultiSelected([]); }
  }

  // ── Save ────────────────────────────────────────────────────────────────────
  async function save() {
    const name = wfName.trim();
    if (!name) { setError('Введите название процесса'); return; }
    let id = wfId.trim();
    if (!id) {
      id = slugify(name) || `process-${Date.now().toString(36)}`;
      setWfId(id);
    }
    setSaving(true); setError(null); setDraftWarning(null as any);
    try {
      const fresh = await api.workflows.list().catch(() => workflows);
      const exists = fresh.find(w => w.id === id);
      const elementsWithPos = elements.map(el => ({
        ...el,
        x: positions[el.id]?.x ?? 0,
        y: positions[el.id]?.y ?? 0,
      }));
      const body = { id, name, elements: elementsWithPos, flow, ...(exists ? {} : { version: '1.0.0' }) } as unknown as Workflow;
      let savedAsDraft = false;
      let validationMsg: string | null = null;
      try {
        if (exists) await api.workflows.update(id, body, false);
        else        await api.workflows.create(body, false);
      } catch (validationErr: any) {
        validationMsg = validationErr.message ?? null;
        // Validation failed — save as draft instead
        if (exists) await api.workflows.update(id, body, true);
        else        await api.workflows.create(body, true);
        savedAsDraft = true;
      }
      refreshList();
      if (savedAsDraft) {
        const details = validationMsg ? validationMsg.split('\n').map(s => s.trim()).filter(Boolean) : [];
        setDraftWarning({ text: 'Процесс сохранён как черновик — схема некорректна, недоступна для запуска', details });
      }
    } catch (err: any) { setError(err.message); }
    setSaving(false);
  }

  // Keep saveRef current on every render so debounced timer always calls latest save
  saveRef.current = save;
  // Keep pan/zoom refs current for gesture handlers registered with empty deps
  panXRef.current = panX; panYRef.current = panY; zoomRef.current = zoom;

  const isKnown = workflows.some(w => w.id === wfId.trim());

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${(ms / 3600000).toFixed(1)}h`;
  }

  // ── Process mining ───────────────────────────────────────────────────────────
  async function toggleMining() {
    if (showMining) { setShowMining(false); return; }
    if (!wfId.trim()) return;
    setShowMining(true);
    setMiningLoading(true);
    try {
      const data = await api.mining.process(wfId.trim());
      setMiningData(data);
    } catch {
      setMiningData(null);
    } finally {
      setMiningLoading(false);
    }
  }

  // ── Tsunade chat ─────────────────────────────────────────────────────────────
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMsgs]);

  async function sendToTsunade() {
    const msg = chatInput.trim();
    if (!msg || chatBusy) return;
    setChatInput('');
    setChatMsgs(prev => [...prev, { role: 'user', text: msg }]);
    setChatBusy(true);
    const schema: Record<string, unknown> = { id: wfId, name: wfName, elements, flow, positions };
    if (showMining && miningData) {
      schema.mining = {
        case_count: miningData.case_count,
        bottleneck_element_id: miningData.bottleneck_element_id,
        skipped_elements: miningData.skipped_elements,
        deviation_elements: miningData.deviation_elements,
        elements: Object.fromEntries(
          Object.entries(miningData.elements).map(([id, s]) => [id, {
            label: s.label, visit_count: s.visit_count, avg_duration_ms: s.avg_duration_ms,
          }])
        ),
      };
    }
    try {
      const res = await api.tsunade.chat({ message: msg, schema, chat_id: chatId ?? undefined });
      if (!chatId) setChatId(res.chat_id);
      setChatMsgs(prev => [...prev, { role: 'assistant', text: res.reply }]);

      // Apply schema patch if present
      const patch = res.schema_patch as any;
      if (patch) {
        pushSnapshot();
        if (patch.update_elements?.length) {
          patch.update_elements.forEach((upd: any) => {
            if (upd.id) {
              const { id, ...rest } = upd;
              updateElement(id, rest);
            }
          });
        }
        if (patch.update_positions) {
          setPositions(prev => ({ ...prev, ...patch.update_positions }));
        }
        if (patch.add_elements?.length) {
          patch.add_elements.forEach((el: any) => {
            const id = el.id || `el-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const { x = 100, y = 100, ...rest } = el;
            setElements(prev => [...prev, { id, type: rest.type || 'function', label: rest.label || 'Новый элемент', ...rest }]);
            setPositions(prev => ({ ...prev, [id]: { x, y } }));
          });
        }
        if (patch.remove_elements?.length) {
          patch.remove_elements.forEach((id: string) => {
            setElements(prev => prev.filter(e => e.id !== id));
            setPositions(prev => { const n = { ...prev }; delete n[id]; return n; });
            setFlow(prev => prev.filter(([f, t]) => f !== id && t !== id));
          });
        }
        if (patch.update_elements?.length || patch.update_positions || patch.add_elements?.length || patch.remove_elements?.length) {
          setChatMsgs(prev => [...prev, { role: 'system', text: 'Схема обновлена. Нажмите 💾 для сохранения.' }]);
        }
      }
    } catch (e: any) {
      setChatMsgs(prev => [...prev, { role: 'error', text: `Ошибка: ${e.message}` }]);
    } finally {
      setChatBusy(false);
    }
  }

  // ── Undo / redo ─────────────────────────────────────────────────────────────
  function pushSnapshot() {
    setUndoStack(prev => [...prev.slice(-49), { els: elements, fl: flow, pos: positions }]);
    setRedoStack([]);
  }

  function undo() {
    setUndoStack(prev => {
      if (prev.length === 0) return prev;
      const snap = prev[prev.length - 1];
      setRedoStack(r => [...r.slice(-49), { els: elements, fl: flow, pos: positions }]);
      setElements(snap.els); setFlow(snap.fl); setPositions(snap.pos);
      setSelected(null); setMultiSelected([]);
      return prev.slice(0, -1);
    });
  }

  function redo() {
    setRedoStack(prev => {
      if (prev.length === 0) return prev;
      const snap = prev[prev.length - 1];
      setUndoStack(u => [...u.slice(-49), { els: elements, fl: flow, pos: positions }]);
      setElements(snap.els); setFlow(snap.fl); setPositions(snap.pos);
      setSelected(null); setMultiSelected([]);
      return prev.slice(0, -1);
    });
  }

  // ── Autosave (2s debounce) ───────────────────────────────────────────────────
  function scheduleAutosave() {
    if (!wfName.trim()) return;
    setAutosavePending(true);
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(async () => {
      await saveRef.current();
      setAutosavePending(false);
    }, 2000);
  }

  function loadWorkflow(id: string, fromBreadcrumb?: { id: string; name: string }[]) {
    const wf = workflows.find(w => w.id === id);
    if (!wf) return;
    setWfId(wf.id); setWfName(wf.name || wf.id);
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
    // Restore breadcrumb: if explicitly provided use that, otherwise rebuild from parent_id chain
    if (fromBreadcrumb !== undefined) {
      setBreadcrumb(fromBreadcrumb);
    } else if ((wf as any).parent_id) {
      // Reconstruct breadcrumb by following parent_id chain
      const chain: { id: string; name: string }[] = [];
      let cur: Workflow | undefined = wf;
      const visited = new Set<string>();
      while (cur && (cur as any).parent_id && !visited.has(cur.id)) {
        visited.add(cur.id);
        const parentId = (cur as any).parent_id as string;
        const parent = workflows.find(w => w.id === parentId);
        if (parent) chain.unshift({ id: parent.id, name: parent.name || parent.id });
        cur = parent;
      }
      setBreadcrumb(chain);
    } else {
      setBreadcrumb([]);
    }
  }

  // Drill down into a sub-process from a Function node
  async function drillDown(funcEl: WorkflowElement) {
    if (!wfId) return;
    // Save current first
    await saveRef.current();
    const childId = `${wfId}--${funcEl.id}`;
    const childName = funcEl.label;
    // Determine boundary events from parent flow
    const incomingEvents = flow
      .filter(([, to]) => to === funcEl.id)
      .map(([from]) => elements.find(e => e.id === from))
      .filter(e => e?.type === 'event') as WorkflowElement[];
    const outgoingEvents = flow
      .filter(([from]) => from === funcEl.id)
      .map(([, to]) => elements.find(e => e.id === to))
      .filter(e => e?.type === 'event') as WorkflowElement[];

    // Fetch fresh list to check if child already exists
    let freshList = await api.workflows.list().catch(() => workflows);
    if (!freshList.find(w => w.id === childId)) {
      // Build child workflow with immutable boundary events
      const childEls: WorkflowElement[] = [];
      // Start events (locked, x=40)
      incomingEvents.forEach((ev, i) => {
        childEls.push({ ...ev, id: `start-${i + 1}`, locked: true, x: 40, y: snap(40 + i * (EH + 80)) });
      });
      // End events (locked, x=600)
      outgoingEvents.forEach((ev, i) => {
        childEls.push({ ...ev, id: `end-${i + 1}`, locked: true, x: 600, y: snap(40 + i * (EH + 80)) });
      });
      const childBody = {
        id: childId,
        name: childName,
        version: '1.0.0',
        elements: childEls,
        flow: [],
        parent_id: wfId,
        parent_function_id: funcEl.id,
      };
      try {
        await api.workflows.create(childBody as unknown as Workflow, true); // draft — boundary events only
      } catch { /* may already exist */ }
      freshList = await api.workflows.list().catch(() => freshList);
      setWorkflows(freshList);
    }

    // Navigate into child — load from fresh list
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
              {breadcrumb.length > 0 ? (
                <div className="ipe-breadcrumb">
                  {breadcrumb.map((crumb, i) => (
                    <span key={crumb.id} style={{ display: 'contents' }}>
                      {i > 0 && <span className="bc-sep">›</span>}
                      <a onClick={() => {
                        // Navigate back up — pop breadcrumb to this level
                        const newCrumb = breadcrumb.slice(0, i);
                        loadWorkflow(crumb.id, newCrumb);
                      }}>{crumb.name}</a>
                    </span>
                  ))}
                  <span className="bc-sep">›</span>
                  <span className="bc-current">{wfName}</span>
                </div>
              ) : (
                <span style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 500, flexShrink: 0, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {wfName}
                </span>
              )}
            </>
          )}
          <div className="sep" />
          <button title="Ctrl+Z" style={{ padding: '5px 8px' }}
            onClick={undo} disabled={undoStack.length === 0}>↩</button>
          <button title="Ctrl+Y" style={{ padding: '5px 8px' }}
            onClick={redo} disabled={redoStack.length === 0}>↪</button>
          <div className="sep" />
          <button className="btn-save" onClick={save} disabled={saving}>
            {saving ? 'Сохранение…' : '💾 Сохранить'}
          </button>
          <div className="sep" />
          <button className={`btn-tsunade${showChat ? ' active' : ''}`} onClick={() => setShowChat(v => !v)}>
            💬 Цунаде
          </button>
          {wfId.trim() && (
            <button
              className={showMining ? 'active' : ''}
              onClick={toggleMining}
              title="Process Mining — overlay actual execution stats on canvas"
              style={{ background: showMining ? '#065f46' : '#1e3a2f', borderColor: '#10b981' }}
            >
              {miningLoading ? '⏳' : '⛏'} Mining
            </button>
          )}
          {autosavePending && !saving && <span style={{ color: '#94a3b8', fontSize: 11 }}>автосохранение…</span>}
          {error && <span style={{ color: '#fca5a5', fontSize: 12 }}>{error}</span>}
          {draftWarning && (
            <span className="warn-wrap" style={{ color: '#fbbf24', fontSize: 12 }}>
              ⚠ {draftWarning.text}{draftWarning.details.length > 0 ? ' ▾' : ''}
              {draftWarning.details.length > 0 && (
                <div className="warn-pop">
                  <ul>
                    {draftWarning.details.map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                </div>
              )}
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
                {selEl.type === 'event' && !flow.some(([, to]) => to === selEl.id) && (
                  // Start event — show trigger configuration
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.05em', margin: '14px 0 8px', paddingBottom: 4, borderBottom: '1px solid #f1f5f9' }}>Триггер запуска</div>
                    <div className="props-field">
                      <label>Тип триггера</label>
                      <select
                        value={selEl.trigger?.type || 'manual'}
                        onChange={e => updateElement(selEl.id, { trigger: { ...selEl.trigger, type: e.target.value as any } })}
                      >
                        <option value="manual">Manual — кнопка / API</option>
                        <option value="webhook">Webhook — HTTP POST</option>
                        <option value="schedule">Schedule — расписание</option>
                        <option value="telegram">Telegram — входящее сообщение</option>
                        <option value="event">Event — завершение другого процесса</option>
                      </select>
                    </div>
                    {selEl.trigger?.type === 'webhook' && (
                      <div className="props-field">
                        <label>URL вебхука</label>
                        <input
                          readOnly
                          value={`POST /trigger/${wfId || '<process_id>'}`}
                          style={{ background: '#f8fafc', fontFamily: 'monospace', fontSize: 12, color: '#475569' }}
                          onClick={e => (e.target as HTMLInputElement).select()}
                        />
                        <span style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, display: 'block' }}>Тело: {"{ subject, payload }"}</span>
                      </div>
                    )}
                    {selEl.trigger?.type === 'schedule' && (
                      <div className="props-field">
                        <label>Cron-выражение</label>
                        <input
                          value={selEl.trigger?.cron || ''}
                          onChange={e => updateElement(selEl.id, { trigger: { ...selEl.trigger, type: 'schedule', cron: e.target.value } })}
                          placeholder="0 9 * * MON"
                        />
                        <span style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, display: 'block' }}>Пример: 0 9 * * 1-5 — каждый будний день в 9:00</span>
                      </div>
                    )}
                    {selEl.trigger?.type === 'telegram' && (
                      <>
                        <div className="props-field">
                          <label>Chat ID</label>
                          <input
                            value={selEl.trigger?.chat_id || ''}
                            onChange={e => updateElement(selEl.id, { trigger: { ...selEl.trigger, type: 'telegram', chat_id: e.target.value } })}
                            placeholder="Числовой ID чата"
                          />
                        </div>
                        <div className="props-field">
                          <label>Ключевое слово (опционально)</label>
                          <input
                            value={selEl.trigger?.keyword || ''}
                            onChange={e => updateElement(selEl.id, { trigger: { ...selEl.trigger, type: 'telegram', keyword: e.target.value } })}
                            placeholder="Фильтр по тексту сообщения"
                          />
                        </div>
                      </>
                    )}
                    {selEl.trigger?.type === 'event' && (
                      <div className="props-field">
                        <label>Тип события</label>
                        <input
                          value={selEl.trigger?.event_type || ''}
                          onChange={e => updateElement(selEl.id, { trigger: { ...selEl.trigger, type: 'event', event_type: e.target.value } })}
                          placeholder="Например: lead.qualified"
                        />
                      </div>
                    )}
                  </div>
                )}
                {selEl.type === 'document' && (
                  <>
                    <div className="props-field">
                      <label>Тип документа</label>
                      <select
                        value={selEl.content_type || 'instruction'}
                        onChange={e => updateElement(selEl.id, { content_type: e.target.value as 'instruction' | 'file', content: undefined, file_ref: undefined })}
                      >
                        <option value="instruction">Инструкция (текст)</option>
                        <option value="file">Файл из Workspace</option>
                      </select>
                    </div>
                    {(selEl.content_type || 'instruction') === 'instruction' && (
                      <div className="props-field">
                        <label>Содержание</label>
                        <textarea
                          value={selEl.content || ''}
                          onChange={e => updateElement(selEl.id, { content: e.target.value || undefined })}
                          placeholder="Текст инструкции для исполнителя…"
                          rows={6}
                          style={{ width: '100%', padding: '6px 8px', border: '1px solid #ddd', borderRadius: 4, fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }}
                        />
                      </div>
                    )}
                    {selEl.content_type === 'file' && (
                      <div className="props-field">
                        <label>Файл</label>
                        {wsFiles.length > 0 ? (
                          <select
                            value={selEl.file_ref || ''}
                            onChange={e => updateElement(selEl.id, { file_ref: e.target.value || undefined })}
                          >
                            <option value="">— выбрать файл —</option>
                            {wsFiles.map(f => <option key={f} value={f}>{f}</option>)}
                          </select>
                        ) : (
                          <span style={{ fontSize: 12, color: '#94a3b8' }}>Нет файлов в Workspace</span>
                        )}
                        {selEl.file_ref && (
                          <span style={{ fontSize: 11, color: '#64748b', marginTop: 4, display: 'block' }}>
                            /opt/shared/workspace/{selEl.file_ref}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}
                <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace', marginBottom: 4 }}>{selEl.id}</div>
                {selEl.locked && (
                  <div style={{ fontSize: 11, color: '#f59e0b', padding: '4px 8px', background: '#451a03', borderRadius: 4, marginBottom: 6 }}>
                    🔒 Граничное событие — заблокировано
                  </div>
                )}
                {!selEl.locked && (
                  <button className="btn-del-el" onClick={() => deleteElement(selEl.id)}>Удалить элемент</button>
                )}
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

            {/* Mining summary panel */}
            {showMining && miningData && (
              <div>
                <h3>⛏ Mining — {miningData.case_count} case(s)</h3>
                {miningData.bottleneck_element_id && (
                  <div style={{ fontSize: 11, color: '#fca5a5', background: '#450a0a', padding: '4px 8px', borderRadius: 4, marginBottom: 6 }}>
                    🔥 Bottleneck: {miningData.elements[miningData.bottleneck_element_id]?.label || miningData.bottleneck_element_id}
                    {miningData.elements[miningData.bottleneck_element_id]?.avg_duration_ms != null && (
                      <span> — {formatDuration(miningData.elements[miningData.bottleneck_element_id]!.avg_duration_ms!)}</span>
                    )}
                  </div>
                )}
                {miningData.skipped_elements.length > 0 && (
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
                    ⬜ Skipped: {miningData.skipped_elements.map(id => miningData.elements[id]?.label || id).join(', ')}
                  </div>
                )}
                {miningData.deviation_elements.length > 0 && (
                  <div style={{ fontSize: 11, color: '#fbbf24', marginBottom: 4 }}>
                    ⚠ Deviation: {miningData.deviation_elements.map(id => miningData.elements[id]?.label || id).join(', ')}
                  </div>
                )}
                <div style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>
                  Hover elements on canvas for stats
                </div>
              </div>
            )}
          </div>

          {/* ── Resize handle ── */}
          <div className="ipe-resize" onMouseDown={onResizeMouseDown} title="Drag to resize panel" />

          {/* ── Canvas ── */}
          <div className="ipe-canvas">
            <svg
              ref={svgRef}
              style={{ cursor: canvasCursor }}
              onMouseDown={onSvgMouseDown}
              onMouseMove={onSvgMouseMove}
              onMouseUp={onSvgMouseUp}
              onMouseLeave={onSvgMouseUp}
              onClick={onSvgClick}
              onContextMenu={e => e.preventDefault()}
            >
              <defs>
                <pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse"
                  patternTransform={`translate(${panX % 20},${panY % 20})`}>
                  <circle cx="1" cy="1" r="1" fill="#cbd5e1" />
                </pattern>
                <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L8,3 z" fill="#6b7280" />
                </marker>
                <marker id="arr-hi" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L8,3 z" fill="#6366f1" />
                </marker>
              </defs>

              {/* Fixed background — dots shift to align with panned content */}
              <rect width="100%" height="100%" fill="white" />
              <rect width="100%" height="100%" fill="url(#dots)" />

              {/* Panned + zoomed content group */}
              <g transform={`translate(${panX},${panY}) scale(${zoom})`}>

              {/* ── Edges ── */}
              {flow.map(([fId, tId], i) => {
                const fp = positions[fId], tp = positions[tId];
                if (!fp || !tp) return null;
                const srcType = elements.find(e => e.id === fId)?.type;
                const dstType = elements.find(e => e.id === tId)?.type;
                const d = orthogonalPath(fp, tp, srcType, dstType);
                const isHighlighted = selected === fId || selected === tId
                  || multiSelected.includes(fId) || multiSelected.includes(tId);
                const isRoleEdge = srcType === 'role' || dstType === 'role';
                const arrow = isRoleEdge ? undefined : isHighlighted ? 'url(#arr-hi)' : 'url(#arr)';
                // Mining edge overlay
                const miningEdge = showMining && miningData
                  ? miningData.edges[`${fId}:${tId}`]
                  : null;
                const edgeCount = miningEdge?.count ?? 0;
                const maxEdgeCount = showMining && miningData
                  ? Math.max(1, ...Object.values(miningData.edges).map(e => e.count))
                  : 1;
                const miningStroke = showMining && miningData
                  ? (edgeCount === 0 ? '#374151' : `rgba(16,185,129,${0.3 + 0.7 * edgeCount / maxEdgeCount})`)
                  : null;
                const miningWidth = showMining && miningData
                  ? (edgeCount === 0 ? 0.5 : 1.5 + 3 * edgeCount / maxEdgeCount)
                  : null;
                return (
                  <g key={i}>
                    <path d={d}
                      stroke={miningStroke || (isHighlighted ? '#6366f1' : isRoleEdge ? '#B7A000' : '#6b7280')}
                      strokeWidth={miningWidth ?? (isHighlighted ? 2 : 1.5)}
                      strokeDasharray={!showMining && isRoleEdge ? '5 3' : (showMining && edgeCount === 0 ? '4 3' : undefined)}
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
                const anchors = el.type === 'gateway' ? [
                  { ax: EW / 2,      ay: EH / 2 - GR },
                  { ax: EW / 2,      ay: EH / 2 + GR },
                  { ax: EW / 2 - GR, ay: EH / 2 },
                  { ax: EW / 2 + GR, ay: EH / 2 },
                ] : [
                  { ax: EW / 2, ay: 0 },
                  { ax: EW / 2, ay: EH },
                  { ax: 0,      ay: EH / 2 },
                  { ax: EW,     ay: EH / 2 },
                ];
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
                      if (el.locked) return; // locked boundary events cannot be renamed
                      if (el.type === 'gateway') {
                        setGatewayPickerId(prev => prev === el.id ? null : el.id);
                        return;
                      }
                      setEditingId(el.id);
                      setEditingValue(String(el.label ?? ''));
                    }}
                  >
                    {/* Expanded invisible hit area for gateways so hover isn't lost before reaching anchor */}
                    {el.type === 'gateway' && (
                      <circle cx={EW / 2} cy={EH / 2} r={GR + 20} fill="transparent" pointerEvents="all" />
                    )}
                    <ElShape el={el} selected={isSel} connectSrc={isCFrom} isEditing={isEditingThis} />
                    {/* Drill-down badge on function nodes (visible on hover) */}
                    {el.type === 'function' && !isEditingThis && (
                      <g className="drill-badge"
                        style={{ opacity: hoveredEl === el.id ? 0.9 : 0 }}
                        onClick={e2 => { e2.stopPropagation(); drillDown(el); }}
                        title="Детализировать (создать под-процесс)"
                      >
                        <rect x={EW - 24} y={EH - 20} width={22} height={18} rx={4}
                          fill="#1e293b" stroke="#6366f1" strokeWidth={1} />
                        <text x={EW - 13} y={EH - 8} textAnchor="middle" dominantBaseline="middle"
                          fontSize={11} fill="#93c5fd" fontFamily="system-ui" pointerEvents="none">⊞</text>
                      </g>
                    )}
                    {/* Lock indicator on locked (boundary) events */}
                    {el.locked && (
                      <text x={EW - 12} y={12} textAnchor="middle" dominantBaseline="middle"
                        fontSize={10} fill="#f59e0b" fontFamily="system-ui" pointerEvents="none"
                        title="Заблокировано (граница под-процесса)">🔒</text>
                    )}
                    {/* Mining overlay badges */}
                    {showMining && miningData && (() => {
                      const stat = miningData.elements[el.id];
                      const isBottleneck = miningData.bottleneck_element_id === el.id;
                      const isDeviation = miningData.deviation_elements.includes(el.id);
                      const isSkipped = miningData.skipped_elements.includes(el.id);
                      if (!stat && !isSkipped) return null;
                      const visits = stat?.visit_count ?? 0;
                      const avgMs = stat?.avg_duration_ms ?? null;
                      // Bottleneck glow
                      const glowColor = isBottleneck ? '#ef4444' : isDeviation ? '#f59e0b' : null;
                      return (
                        <g className="mining-badge">
                          {/* Background glow for bottleneck/deviation */}
                          {glowColor && (
                            <rect x={-3} y={-3} width={EW + 6} height={EH + 6}
                              rx={el.type === 'gateway' ? EH / 2 + 3 : 12}
                              fill="none" stroke={glowColor} strokeWidth={3} opacity={0.6} />
                          )}
                          {/* Visit count badge (top-left) */}
                          <rect x={0} y={0} width={28} height={16} rx={4}
                            fill={visits > 0 ? '#1e40af' : '#374151'} opacity={0.9} />
                          <text x={14} y={8} textAnchor="middle" dominantBaseline="middle"
                            fontSize={9} fill="white">
                            {visits > 0 ? `×${visits}` : 'skip'}
                          </text>
                          {/* Duration badge (bottom-center) */}
                          {avgMs !== null && (
                            <>
                              <rect x={EW / 2 - 24} y={EH - 16} width={48} height={14} rx={3}
                                fill={isBottleneck ? '#991b1b' : '#065f46'} opacity={0.9} />
                              <text x={EW / 2} y={EH - 9} textAnchor="middle" dominantBaseline="middle"
                                fontSize={8} fill="white">
                                ⌛{formatDuration(avgMs)}
                              </text>
                            </>
                          )}
                        </g>
                      );
                    })()}
                    {showAnchors && anchors.map(({ ax, ay }, i) => (
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

              {/* ── Gateway operator picker ── */}
              {gatewayPickerId && (() => {
                const gpos = positions[gatewayPickerId] || { x: 0, y: 0 };
                const curOp = elements.find(e => e.id === gatewayPickerId)?.operator || 'AND';
                return (
                  <foreignObject x={gpos.x + EW / 2 - 44} y={gpos.y + EH / 2 - 48} width={88} height={96}>
                    <div style={{ background: 'white', border: '1px solid #ddd', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,.18)', padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {(['XOR', 'AND', 'OR'] as const).map(op => (
                        <button key={op}
                          onClick={e => { e.stopPropagation(); updateElement(gatewayPickerId, { operator: op }); setGatewayPickerId(null); }}
                          style={{ padding: '5px 0', background: curOp === op ? '#6366f1' : 'white', color: curOp === op ? 'white' : '#333', border: '1px solid #e2e8f0', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                          {op}
                        </button>
                      ))}
                    </div>
                  </foreignObject>
                );
              })()}

              {elements.length === 0 && (
                <text x={300} y={200} textAnchor="middle" dominantBaseline="middle"
                  fontSize={14} fill="#94a3b8" fontFamily="system-ui,-apple-system,sans-serif" pointerEvents="none">
                  Кликните элемент в палитре, чтобы добавить его на холст
                </text>
              )}
              </g>{/* end panned content group */}
            </svg>
          </div>

          {/* ── Tsunade chat panel ── */}
          {showChat && (
            <div className="tsunade-panel">
              <div className="tsunade-header">
                <span className="tsunade-title">💬 Цунаде — AI-ассистент</span>
                <button className="tsunade-btn-close" onClick={() => setShowChat(false)}>✕</button>
              </div>
              <div className="tsunade-messages">
                {chatMsgs.length === 0 && (
                  <div style={{ color: '#475569', fontSize: 12, textAlign: 'center', padding: '20px 0' }}>
                    Спросите Цунаде о схеме.<br />
                    Например: «Выровняй элементы вертикально» или «Добавь шлюз XOR после функции X».
                  </div>
                )}
                {chatMsgs.map((m, i) => (
                  <div key={i} className={`tsunade-msg ${m.role}`}>{m.text}</div>
                ))}
                {chatBusy && (
                  <div className="tsunade-msg assistant" style={{ opacity: 0.6 }}>Думаю…</div>
                )}
                <div ref={chatBottomRef} />
              </div>
              <div className="tsunade-input-row">
                <textarea
                  className="tsunade-input"
                  rows={2}
                  placeholder="Сообщение Цунаде…"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendToTsunade(); } }}
                />
                <button
                  className="tsunade-send"
                  disabled={chatBusy || !chatInput.trim()}
                  onClick={sendToTsunade}
                >
                  ➤
                </button>
              </div>
            </div>
          )}
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
