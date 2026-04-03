/**
 * ProcessEditor — interactive visual eEPC process editor
 * Drag elements from palette, connect with arrows, save to API.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { api } from '../api/client';
import type { Workflow, WorkflowElement } from '../api/types';

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
  { type: 'event',              label: 'Event',    fill: '#F5C4B3', stroke: '#993C1D' },
  { type: 'function',           label: 'Function', fill: '#C0DD97', stroke: '#3B6D11' },
  { type: 'gateway',            label: 'Gateway',  fill: '#E8F4FD', stroke: '#4B7BA8' },
  { type: 'role',               label: 'Role',     fill: '#FFF9C4', stroke: '#B7A000' },
  { type: 'document',           label: 'Document', fill: '#DBEAFE', stroke: '#3B82F6' },
  { type: 'information_system', label: 'IS',       fill: '#E0F2FE', stroke: '#0EA5E9' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function genId(type: EType, els: WorkflowElement[]): string {
  const p = type.replace('_', '-');
  const nums = els.filter(e => e.id.startsWith(p + '-'))
    .map(e => parseInt(e.id.split('-').pop() || '0', 10));
  return `${p}-${nums.length ? Math.max(...nums) + 1 : 1}`;
}

const CORNER_R = 10; // rounded corner radius for orthogonal routing

/** VHV: vertical → horizontal → vertical path with rounded corners */
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

/** HVH: horizontal → vertical → horizontal path with rounded corners */
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

/** Build an orthogonal SVG path between two element positions with rounded corners */
function orthogonalPath(fp: Pos, tp: Pos): string {
  const fcx = fp.x + EW / 2, fcy = fp.y + EH / 2;
  const tcx = tp.x + EW / 2, tcy = tp.y + EH / 2;
  const dx = tcx - fcx, dy = tcy - fcy;

  if (Math.abs(dy) >= Math.abs(dx)) {
    // Vertical dominant: exit bottom/top, enter top/bottom
    const goDown = dy >= 0;
    const x1 = fcx, y1 = goDown ? fp.y + EH : fp.y;
    const x2 = tcx, y2 = goDown ? tp.y       : tp.y + EH;
    return routeVHV(x1, y1, x2, y2, (y1 + y2) / 2);
  } else {
    // Horizontal dominant: exit right/left, enter left/right
    const goRight = dx >= 0;
    const x1 = goRight ? fp.x + EW : fp.x, y1 = fcy;
    const x2 = goRight ? tp.x       : tp.x + EW, y2 = tcy;
    return routeHVH(x1, y1, x2, y2, (x1 + x2) / 2);
  }
}

/** Grid snap helper */
function snap(v: number, g = 20): number { return Math.round(v / g) * g; }

// ── Element shape SVG ─────────────────────────────────────────────────────────
interface ShapeProps { el: WorkflowElement; selected: boolean; connectSrc: boolean }
function ElShape({ el, selected, connectSrc }: ShapeProps) {
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

  // Simple word-wrap for label
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
      {lines.map((line, i) => (
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
  .ipe-bar input { padding:5px 9px; background:#0f172a; border:1px solid #475569; color:white; border-radius:4px; font-size:13px; }
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
  .load-select { width:100%; padding:6px 8px; border:1px solid #ddd; border-radius:4px; font-size:13px; box-sizing:border-box; margin-bottom:6px; }
  .btn-load { width:100%; padding:7px; background:#0066cc; color:white; border:none; border-radius:4px; cursor:pointer; font-size:13px; font-weight:500; }
  .btn-load:hover { background:#0052a3; }
  .btn-load:disabled { background:#94a3b8; cursor:default; }
  .load-divider { border:none; border-top:1px solid #e2e8f0; margin:4px 0 10px; }
  .btn-del-el { width:100%; padding:5px; font-size:12px; background:#ef4444; color:white; border:none; border-radius:4px; cursor:pointer; margin-top:6px; }
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
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('select');
  const [dragging, setDragging] = useState<{ id: string; ox: number; oy: number; mx: number; my: number } | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loadId,  setLoadId]  = useState('');
  const [sideW,   setSideW]   = useState(240);
  const svgRef    = useRef<SVGSVGElement>(null);
  const resizing  = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartW = useRef(240);

  // ── Load workflow list ──────────────────────────────────────────────────────
  const refreshList = useCallback(() => {
    if (!token) return;
    api.workflows.list().then(setWorkflows).catch(() => {});
  }, [token]);
  useEffect(() => { refreshList(); }, [refreshList]);

  // ── Keyboard delete ─────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!selected) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      deleteElement(selected);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [selected]);  // eslint-disable-line react-hooks/exhaustive-deps

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
  function addElement(type: EType) {
    const id  = genId(type, elements);
    const idx = elements.length;
    const col = idx % 6, row = Math.floor(idx / 6);
    const pos: Pos = { x: snap(40 + col * (EW + 60)), y: snap(40 + row * (EH + 80)) };
    const el: WorkflowElement = { id, type, label: `New ${PALETTE.find(p => p.type === type)?.label || type}` };
    if (type === 'gateway') el.operator = 'AND';
    setElements(prev => [...prev, el]);
    setPositions(prev => ({ ...prev, [id]: pos }));
    setSelected(id);
    setMode('select');
  }

  function deleteElement(id: string) {
    setElements(prev => prev.filter(e => e.id !== id));
    setFlow(prev => prev.filter(([f, t]) => f !== id && t !== id));
    setPositions(prev => { const n = { ...prev }; delete n[id]; return n; });
    setSelected(null);
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
        setConnectFrom(id);
        setSelected(id);
      } else if (connectFrom !== id) {
        if (!flow.some(([f, t]) => f === connectFrom && t === id)) {
          setFlow(prev => [...prev, [connectFrom, id]]);
        }
        setConnectFrom(null);
        setSelected(id);
      }
      return;
    }

    // Select + drag
    const pt  = svgCoords(e);
    const pos = positions[id] || { x: 0, y: 0 };
    setDragging({ id, ox: pos.x, oy: pos.y, mx: pt.x, my: pt.y });
    setSelected(id);
  }

  function onSvgMouseMove(e: React.MouseEvent) {
    if (!dragging) return;
    const pt = svgCoords(e);
    const nx = snap(Math.max(0, dragging.ox + (pt.x - dragging.mx)));
    const ny = snap(Math.max(0, dragging.oy + (pt.y - dragging.my)));
    setPositions(prev => ({ ...prev, [dragging.id]: { x: nx, y: ny } }));
  }

  function onSvgMouseUp() { setDragging(null); }

  function onSvgClick() {
    if (mode === 'connect' && connectFrom) {
      setConnectFrom(null); // cancel connection on background click
    } else {
      setSelected(null);
    }
  }

  // ── Mode toggle ─────────────────────────────────────────────────────────────
  function switchMode(m: Mode) {
    setMode(m);
    setConnectFrom(null);
    if (m === 'connect') setSelected(null);
  }

  // ── Save ────────────────────────────────────────────────────────────────────
  async function save() {
    if (!wfId.trim() || !wfName.trim()) { setError('Process ID and name are required'); return; }
    setSaving(true); setError(null);
    try {
      const body = { id: wfId.trim(), name: wfName.trim(), elements, flow } as unknown as Workflow;
      const exists = workflows.find(w => w.id === wfId.trim());
      if (exists) await api.workflows.update(wfId.trim(), body);
      else        await api.workflows.create(body);
      refreshList();
    } catch (err: any) { setError(err.message); }
    setSaving(false);
  }

  // ── Load existing ───────────────────────────────────────────────────────────
  function loadWorkflow(id: string) {
    const wf = workflows.find(w => w.id === id);
    if (!wf) return;
    setWfId(wf.id);
    setWfName(wf.name || wf.id);
    setElements([...wf.elements]);
    setFlow([...(wf.flow || [])]);
    setSelected(null);
    setConnectFrom(null);
    setMode('select');
    // Auto-place elements in a grid
    const pos: Record<string, Pos> = {};
    wf.elements.forEach((el, i) => {
      const col = i % 6, row = Math.floor(i / 6);
      pos[el.id] = { x: snap(40 + col * (EW + 60)), y: snap(40 + row * (EH + 80)) };
    });
    setPositions(pos);
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  const selEl = elements.find(e => e.id === selected);

  const canvasCursor = mode === 'connect' ? 'crosshair'
    : dragging ? 'grabbing' : 'default';

  return (
    <Layout activePage="editor.html">
      <style>{CSS}</style>
      <div className="ipe-root">

        {/* ── Toolbar ── */}
        <div className="ipe-bar">
          <span style={{ color: '#94a3b8', fontSize: 12, flexShrink: 0 }}>Process Editor</span>
          <div className="sep" />
          <input
            placeholder="Process name…"
            value={wfName}
            onChange={e => setWfName(e.target.value)}
            style={{ width: 200 }}
          />
          <input
            placeholder="ID (e.g. order-flow)…"
            value={wfId}
            onChange={e => setWfId(e.target.value)}
            style={{ width: 180 }}
          />
          <div className="sep" />
          <button
            className={mode === 'select' ? 'active' : ''}
            onClick={() => switchMode('select')}
            title="Select & drag elements (V)">
            ↖ Select
          </button>
          <button
            className={mode === 'connect' ? 'active' : ''}
            onClick={() => switchMode('connect')}
            title="Draw connections between elements (C)">
            ⟶ Connect
          </button>
          <div className="sep" />
          <button className="btn-save" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : '💾 Save'}
          </button>
          {error && <span style={{ color: '#fca5a5', fontSize: 12 }}>{error}</span>}
          {mode === 'connect' && (
            <span className="hint">
              {connectFrom
                ? `Source: ${connectFrom} — click target element`
                : 'Click source element…'}
            </span>
          )}
        </div>

        <div className="ipe-body">

          {/* ── Sidebar ── */}
          <div className="ipe-side" style={{ width: sideW }}>

            {/* Load process */}
            <div>
              <h3>📂 Load Existing Process</h3>
              <select
                className="load-select"
                value={loadId}
                onChange={e => setLoadId(e.target.value)}
              >
                <option value="">— choose a process —</option>
                {workflows.map(w => (
                  <option key={w.id} value={w.id}>{w.name || w.id}</option>
                ))}
              </select>
              <button
                className="btn-load"
                onClick={() => { loadWorkflow(loadId); setLoadId(''); }}
                disabled={!loadId}
              >
                ↓ Load Process
              </button>
              <hr className="load-divider" />
            </div>

            {/* Element palette */}
            <div>
              <h3>Add Element</h3>
              {PALETTE.map(p => (
                <div key={p.type} className="pal-item" onClick={() => addElement(p.type)}>
                  <div className="pal-dot" style={{ background: p.fill, border: `1px solid ${p.stroke}` }} />
                  {p.label}
                </div>
              ))}
            </div>

            {/* Properties panel */}
            {selEl && (
              <div>
                <h3>Properties</h3>
                <div className="props-field">
                  <label>Label</label>
                  <input
                    value={selEl.label}
                    onChange={e => updateElement(selEl.id, { label: e.target.value })}
                  />
                </div>
                {selEl.type === 'gateway' && (
                  <div className="props-field">
                    <label>Operator</label>
                    <select
                      value={selEl.operator || 'AND'}
                      onChange={e => updateElement(selEl.id, { operator: e.target.value })}>
                      <option>AND</option>
                      <option>OR</option>
                      <option>XOR</option>
                    </select>
                  </div>
                )}
                {selEl.type === 'function' && (
                  <div className="props-field">
                    <label>Role</label>
                    <input
                      value={selEl.role || ''}
                      placeholder="Assigned role…"
                      onChange={e => updateElement(selEl.id, { role: e.target.value || undefined })}
                    />
                  </div>
                )}
                <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace', marginBottom: 4 }}>{selEl.id}</div>
                <button className="btn-del-el" onClick={() => deleteElement(selEl.id)}>
                  Delete Element
                </button>
              </div>
            )}

            {/* Connection list */}
            {flow.length > 0 && (
              <div>
                <h3>Connections ({flow.length})</h3>
                {flow.map(([f, t], i) => (
                  <div key={i} className="edge-item">
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f} → {t}
                    </span>
                    <button className="edge-del" onClick={() => removeEdge(f, t)}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Resize handle ── */}
          <div
            className="ipe-resize"
            onMouseDown={onResizeMouseDown}
            title="Drag to resize panel"
          />

          {/* ── Canvas ── */}
          <div className="ipe-canvas">
            <svg
              ref={svgRef}
              width={CW}
              height={CH}
              style={{ cursor: canvasCursor }}
              onMouseMove={onSvgMouseMove}
              onMouseUp={onSvgMouseUp}
              onMouseLeave={onSvgMouseUp}
              onClick={onSvgClick}
            >
              <defs>
                {/* Dot grid */}
                <pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse">
                  <circle cx="1" cy="1" r="1" fill="#cbd5e1" />
                </pattern>
                {/* Arrowhead */}
                <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L8,3 z" fill="#6b7280" />
                </marker>
                {/* Highlighted arrowhead */}
                <marker id="arr-hi" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L8,3 z" fill="#6366f1" />
                </marker>
              </defs>

              {/* Background */}
              <rect width={CW} height={CH} fill="white" />
              <rect width={CW} height={CH} fill="url(#dots)" />

              {/* ── Edges ── */}
              {flow.map(([fId, tId], i) => {
                const fp = positions[fId], tp = positions[tId];
                if (!fp || !tp) return null;
                const d = orthogonalPath(fp, tp);
                const isHighlighted = selected === fId || selected === tId;
                return (
                  <g key={i}>
                    <path
                      d={d}
                      stroke={isHighlighted ? '#6366f1' : '#6b7280'}
                      strokeWidth={isHighlighted ? 2 : 1.5}
                      fill="none"
                      markerEnd={isHighlighted ? 'url(#arr-hi)' : 'url(#arr)'}
                    />
                    {/* Wider invisible hit area for deletion */}
                    <path
                      d={d}
                      stroke="transparent" strokeWidth={12} fill="none"
                      style={{ cursor: 'pointer' }}
                      onClick={e => { e.stopPropagation(); removeEdge(fId, tId); }}
                    />
                  </g>
                );
              })}

              {/* ── Elements ── */}
              {elements.map(el => {
                const pos = positions[el.id] || { x: 40, y: 40 };
                const isSel   = selected    === el.id;
                const isCFrom = connectFrom === el.id;
                const elCursor = mode === 'select'
                  ? (dragging?.id === el.id ? 'grabbing' : 'grab')
                  : 'pointer';
                return (
                  <g
                    key={el.id}
                    transform={`translate(${pos.x},${pos.y})`}
                    style={{ cursor: elCursor }}
                    onMouseDown={e => onElMouseDown(e, el.id)}
                    onClick={e => e.stopPropagation()}
                  >
                    <ElShape el={el} selected={isSel} connectSrc={isCFrom} />
                  </g>
                );
              })}

              {/* Empty hint */}
              {elements.length === 0 && (
                <text
                  x={CW / 2} y={CH / 2}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize={14} fill="#94a3b8"
                  fontFamily="system-ui,-apple-system,sans-serif"
                  pointerEvents="none">
                  Click elements in the palette to add them to the canvas
                </text>
              )}
            </svg>
          </div>
        </div>
      </div>
    </Layout>
  );
}
