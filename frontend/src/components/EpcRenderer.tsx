/**
 * EpcRenderer.tsx — React wrapper for the eEPC SVG renderer.
 * Ports epc-renderer.js logic to a typed React component.
 */
import { useEffect, useRef } from 'react';
import type { Workflow, WorkflowElement, Case } from '../api/types';

// ── Layout constants ──────────────────────────────────────────────────────────
const NODE_W  = 180;
const NODE_H  =  60;
const GW_R    =  28;
const H_GAP   =  50;
const V_GAP   =  90;
const PADDING =  30;
const SVG_NS  = 'http://www.w3.org/2000/svg';

// ── Status styles ─────────────────────────────────────────────────────────────
type StatusStyle = { stroke?: string; strokeWidth?: number; opacity?: number; fill?: string; dashArray?: string; cls?: string };
const STATUS_STYLE: Record<string, StatusStyle> = {
  completed:   { stroke: '#22c55e', strokeWidth: 2 },
  running:     { stroke: '#f59e0b', strokeWidth: 3, cls: 'epc-running' },
  waiting:     { stroke: '#9ca3af', strokeWidth: 1.5, fill: '#d1d5db', dashArray: '5 3' },
  error:       { stroke: '#ef4444', strokeWidth: 3, cls: 'epc-error' },
  not_reached: { strokeWidth: 0.5, opacity: 0.4 },
};

// ── SVG helpers ───────────────────────────────────────────────────────────────
function el(tag: string, attrs: Record<string, string | number | null | undefined>, parent?: Element): Element {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) e.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(e);
  return e;
}

function applyStatus(shape: Element, s: StatusStyle) {
  if (s.stroke)      shape.setAttribute('stroke', s.stroke);
  if (s.strokeWidth) shape.setAttribute('stroke-width', String(s.strokeWidth));
  if (s.opacity !== undefined && s.opacity !== 1) shape.setAttribute('opacity', String(s.opacity));
  if (s.fill)        shape.setAttribute('fill', s.fill);
  if (s.dashArray)   shape.setAttribute('stroke-dasharray', s.dashArray);
  if (s.cls)         shape.setAttribute('class', s.cls);
}

function addLabel(g: Element, text: string, cx: number, cy: number, maxWidth: number) {
  const words = String(text).split(' ');
  const lineH = 14, charW = 6.5;
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? cur + ' ' + w : w;
    if (candidate.length * charW > maxWidth && cur) { lines.push(cur); cur = w; }
    else cur = candidate;
  }
  if (cur) lines.push(cur);
  const startY = cy - ((lines.length - 1) * lineH) / 2;
  lines.forEach((line, i) => {
    const t = el('text', { x: cx, y: startY + i * lineH, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 12, 'font-family': 'system-ui, -apple-system, sans-serif', fill: '#1a1a1a', 'pointer-events': 'none' }, g);
    t.textContent = line;
  });
}

// ── Shape renderers ───────────────────────────────────────────────────────────
function renderEvent(g: Element, node: WorkflowElement, s: StatusStyle) {
  const W = NODE_W, H = NODE_H, D = 25;
  const shape = el('polygon', { points: `${D},0 ${W-D},0 ${W},${H/2} ${W-D},${H} ${D},${H} 0,${H/2}`, fill: '#F5C4B3', stroke: '#993C1D', 'stroke-width': 0.5 }, g);
  applyStatus(shape, s);
  addLabel(g, node.label, W / 2, H / 2, W - D * 2 - 4);
}

function renderFunction(g: Element, node: WorkflowElement, s: StatusStyle) {
  const W = NODE_W, H = NODE_H;
  const shape = el('rect', { width: W, height: H, rx: 12, fill: '#C0DD97', stroke: '#3B6D11', 'stroke-width': 0.5 }, g);
  applyStatus(shape, s);
  addLabel(g, node.label, W / 2, H / 2, W - 24);
  if (node.role) {
    const RW = 68, RH = 32, GAP = 12;
    el('line', { x1: W, y1: H / 2, x2: W + GAP, y2: H / 2, stroke: '#9ca3af', 'stroke-width': 1, 'stroke-dasharray': '3 2', 'pointer-events': 'none' }, g);
    const rg = el('g', { transform: `translate(${W + GAP}, ${(H - RH) / 2})` }, g);
    el('ellipse', { cx: RW / 2, cy: RH / 2, rx: RW / 2 - 1, ry: RH / 2 - 1, fill: '#FFF9C4', stroke: '#B7A000', 'stroke-width': 1 }, rg);
    el('line', { x1: 10, y1: 3, x2: 10, y2: RH - 3, stroke: '#B7A000', 'stroke-width': 1.5 }, rg);
    const rt = el('text', { x: RW / 2 + 4, y: RH / 2, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 9, 'font-family': 'system-ui, sans-serif', fill: '#78600a', 'pointer-events': 'none' }, rg);
    rt.textContent = node.role;
  }
}

function renderGateway(g: Element, node: WorkflowElement, s: StatusStyle) {
  const CX = NODE_W / 2, CY = NODE_H / 2;
  const shape = el('circle', { cx: CX, cy: CY, r: GW_R, fill: '#E8F4FD', stroke: '#4B7BA8', 'stroke-width': 1.5 }, g);
  applyStatus(shape, s);
  const t = el('text', { x: CX, y: CY, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 13, 'font-weight': 'bold', 'font-family': 'system-ui, sans-serif', fill: '#2c5f8a', 'pointer-events': 'none' }, g);
  t.textContent = node.operator || node.label || '?';
}

function renderRole(g: Element, node: WorkflowElement, s: StatusStyle) {
  const W = NODE_W, H = NODE_H;
  const shape = el('ellipse', { cx: W / 2, cy: H / 2, rx: W / 2 - 2, ry: H / 2 - 2, fill: '#FFF9C4', stroke: '#B7A000', 'stroke-width': 1 }, g);
  applyStatus(shape, s);
  el('line', { x1: 14, y1: 4, x2: 14, y2: H - 4, stroke: '#B7A000', 'stroke-width': 1.5 }, g);
  addLabel(g, node.label, W / 2 + 4, H / 2, W - 30);
}

function renderDocument(g: Element, node: WorkflowElement, s: StatusStyle) {
  const W = NODE_W, H = NODE_H;
  const wave = `M0,${H-10} Q${W/4},${H+4} ${W/2},${H-10} Q${3*W/4},${H-24} ${W},${H-10} L${W},0 L0,0 Z`;
  const shape = el('path', { d: wave, fill: '#DBEAFE', stroke: '#3B82F6', 'stroke-width': 1 }, g);
  applyStatus(shape, s);
  addLabel(g, node.label, W / 2, (H - 10) / 2, W - 16);
}

function renderInfoSystem(g: Element, node: WorkflowElement, s: StatusStyle) {
  const W = NODE_W, H = NODE_H;
  const shape = el('rect', { width: W, height: H, fill: '#E0F2FE', stroke: '#0EA5E9', 'stroke-width': 1 }, g);
  applyStatus(shape, s);
  el('line', { x1: 6, y1: 2, x2: 6, y2: H - 2, stroke: '#0EA5E9', 'stroke-width': 1 }, g);
  el('line', { x1: W - 6, y1: 2, x2: W - 6, y2: H - 2, stroke: '#0EA5E9', 'stroke-width': 1 }, g);
  addLabel(g, node.label, W / 2, H / 2, W - 28);
}

function renderFallback(g: Element, node: WorkflowElement, s: StatusStyle) {
  const shape = el('rect', { width: NODE_W, height: NODE_H, fill: '#f3f4f6', stroke: '#9ca3af', 'stroke-width': 1 }, g);
  applyStatus(shape, s);
  addLabel(g, node.label, NODE_W / 2, NODE_H / 2, NODE_W - 16);
}

// drawNodeScaled renders a side element at a custom width
function drawNodeScaled(g: Element, node: WorkflowElement, s: StatusStyle, w: number) {
  const H = NODE_H;
  switch (node.type) {
    case 'role': {
      const shape = el('ellipse', { cx: w/2, cy: H/2, rx: w/2-2, ry: H/2-2, fill: '#FFF9C4', stroke: '#B7A000', 'stroke-width': 1 }, g);
      applyStatus(shape, s);
      el('line', { x1: 14, y1: 4, x2: 14, y2: H-4, stroke: '#B7A000', 'stroke-width': 1.5 }, g);
      addLabel(g, node.label, w/2+4, H/2, w-30);
      break;
    }
    case 'document': {
      const wave = `M0,${H-10} Q${w/4},${H+4} ${w/2},${H-10} Q${3*w/4},${H-24} ${w},${H-10} L${w},0 L0,0 Z`;
      const shape = el('path', { d: wave, fill: '#DBEAFE', stroke: '#3B82F6', 'stroke-width': 1 }, g);
      applyStatus(shape, s);
      addLabel(g, node.label, w/2, (H-10)/2, w-16);
      break;
    }
    case 'information_system':
    case 'system': {
      const shape = el('rect', { width: w, height: H, fill: '#E0F2FE', stroke: '#0EA5E9', 'stroke-width': 1 }, g);
      applyStatus(shape, s);
      el('line', { x1: 6, y1: 2, x2: 6, y2: H-2, stroke: '#0EA5E9', 'stroke-width': 1 }, g);
      el('line', { x1: w-6, y1: 2, x2: w-6, y2: H-2, stroke: '#0EA5E9', 'stroke-width': 1 }, g);
      addLabel(g, node.label, w/2, H/2, w-28);
      break;
    }
    default:
      drawNode(g, node, s);
  }
}

function drawNode(g: Element, node: WorkflowElement, s: StatusStyle) {
  switch (node.type) {
    case 'event':            return renderEvent(g, node, s);
    case 'function':         return renderFunction(g, node, s);
    case 'gateway':          return renderGateway(g, node, s);
    case 'role':             return renderRole(g, node, s);
    case 'document':         return renderDocument(g, node, s);
    case 'information_system':
    case 'system':           return renderInfoSystem(g, node, s);
    default:                 return renderFallback(g, node, s);
  }
}

// ── Side element detection ────────────────────────────────────────────────────
const SIDE_TYPES = new Set(['role', 'document', 'information_system', 'system']);
function isSide(e: WorkflowElement) { return SIDE_TYPES.has(e.type); }

// ── Layout ────────────────────────────────────────────────────────────────────
function assignLayers(elements: WorkflowElement[], flow: [string, string, string?][]): Record<string, number> {
  // Only assign layers for main flow elements (events, functions, gateways)
  const mainEls = elements.filter(e => !isSide(e));
  const mainIds = new Set(mainEls.map(e => e.id));
  const inCount: Record<string, number> = {};
  const outEdges: Record<string, string[]> = {};
  mainEls.forEach(e => { inCount[e.id] = 0; outEdges[e.id] = []; });
  flow.forEach(([from, to]) => {
    if (mainIds.has(from) && mainIds.has(to)) {
      outEdges[from].push(to); inCount[to] = (inCount[to] || 0) + 1;
    }
  });
  const layer: Record<string, number> = {};
  const queue = mainEls.filter(e => !inCount[e.id]).map(e => e.id);
  queue.forEach(id => { layer[id] = 0; });
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    for (const to of (outEdges[id] || [])) {
      const proposed = layer[id] + 1;
      if (layer[to] === undefined || layer[to] < proposed) { layer[to] = proposed; queue.push(to); }
    }
  }
  mainEls.forEach(e => { if (layer[e.id] === undefined) layer[e.id] = 0; });
  return layer;
}

const SIDE_GAP = 16;   // gap between function and side element
const SIDE_W   = 160;  // side element width (slightly narrower)

function computeLayout(elements: WorkflowElement[], flow: [string, string, string?][], layer: Record<string, number>) {
  const mainEls = elements.filter(e => !isSide(e));
  const sideEls = elements.filter(e => isSide(e));

  const byLayer: Record<number, string[]> = {};
  mainEls.forEach(e => { const l = layer[e.id]; if (!byLayer[l]) byLayer[l] = []; byLayer[l].push(e.id); });
  const numLayers = Math.max(...Object.keys(byLayer).map(Number), 0) + 1;
  let maxMainW = 0;
  Object.values(byLayer).forEach(ids => { const w = ids.length * NODE_W + (ids.length - 1) * H_GAP; if (w > maxMainW) maxMainW = w; });

  // Main flow canvas core width
  const coreWidth = maxMainW + PADDING * 2;
  const canvasHeight = numLayers * NODE_H + (numLayers - 1) * V_GAP + PADDING * 2;

  // Position main elements (centered)
  const positions: Record<string, { x: number; y: number }> = {};
  Object.entries(byLayer).forEach(([lStr, ids]) => {
    const l = parseInt(lStr);
    const totalW = ids.length * NODE_W + (ids.length - 1) * H_GAP;
    const startX = (coreWidth - totalW) / 2;
    ids.forEach((id, i) => { positions[id] = { x: startX + i * (NODE_W + H_GAP), y: PADDING + l * (NODE_H + V_GAP) }; });
  });

  // Build side element → connected function mapping
  // edge: side -> func = input side (left); func -> side = output side (right)
  const funcIds = new Set(mainEls.filter(e => e.type === 'function').map(e => e.id));
  const sideRight: Record<string, string[]> = {}; // funcId -> [sideIds on right]
  const sideLeft:  Record<string, string[]> = {}; // funcId -> [sideIds on left]

  flow.forEach(([from, to]) => {
    if (funcIds.has(from) && sideEls.some(s => s.id === to)) {
      if (!sideRight[from]) sideRight[from] = [];
      sideRight[from].push(to);
    } else if (sideEls.some(s => s.id === from) && funcIds.has(to)) {
      if (!sideLeft[to]) sideLeft[to] = [];
      sideLeft[to].push(from);
    }
  });

  // Position side elements beside their connected functions
  const maxRightCols: Record<string, number> = {};
  const maxLeftCols:  Record<string, number> = {};

  Object.entries(sideRight).forEach(([funcId, sids]) => {
    const fp = positions[funcId]; if (!fp) return;
    const colX = fp.x + NODE_W + SIDE_GAP;
    sids.forEach((sid, i) => {
      positions[sid] = { x: colX, y: fp.y + i * (NODE_H + 8) };
    });
    maxRightCols[funcId] = SIDE_W + SIDE_GAP;
  });

  Object.entries(sideLeft).forEach(([funcId, sids]) => {
    const fp = positions[funcId]; if (!fp) return;
    sids.forEach((sid, i) => {
      const colX = fp.x - SIDE_W - SIDE_GAP;
      positions[sid] = { x: colX, y: fp.y + i * (NODE_H + 8) };
    });
    maxLeftCols[funcId] = SIDE_W + SIDE_GAP;
  });

  // Unconnected side elements: place them to the right of everything
  const unpositioned = sideEls.filter(s => !positions[s.id]);
  let uy = PADDING;
  unpositioned.forEach(s => {
    positions[s.id] = { x: coreWidth + SIDE_GAP, y: uy };
    uy += NODE_H + 8;
  });

  // Calculate actual canvas width considering right side elements
  const maxX = Math.max(...Object.values(positions).map(p => p.x + SIDE_W), coreWidth);
  const minX = Math.min(...Object.values(positions).map(p => p.x), 0);
  const xOffset = minX < 0 ? -minX + PADDING : 0;

  if (xOffset > 0) {
    Object.keys(positions).forEach(id => { positions[id].x += xOffset; });
  }

  const canvasWidth = maxX + xOffset + PADDING + SIDE_W;

  return { positions, canvasWidth, canvasHeight, sideRight, sideLeft };
}

// ── Edge routing (orthogonal) ─────────────────────────────────────────────────
function bottomOf(id: string, nodeMap: Record<string, WorkflowElement>, pos: Record<string, { x: number; y: number }>) {
  const p = pos[id]; const cx = p.x + NODE_W / 2;
  return nodeMap[id]?.type === 'gateway' ? { x: cx, y: p.y + NODE_H / 2 + GW_R } : { x: cx, y: p.y + NODE_H };
}
function topOf(id: string, nodeMap: Record<string, WorkflowElement>, pos: Record<string, { x: number; y: number }>) {
  const p = pos[id]; const cx = p.x + NODE_W / 2;
  return nodeMap[id]?.type === 'gateway' ? { x: cx, y: p.y + NODE_H / 2 - GW_R } : { x: cx, y: p.y };
}

function drawEdge(svg: Element, from: string, to: string, nodeMap: Record<string, WorkflowElement>, pos: Record<string, { x: number; y: number }>) {
  const fp = bottomOf(from, nodeMap, pos);
  const tp = topOf(to, nodeMap, pos);
  let d: string;
  if (Math.abs(fp.x - tp.x) < 0.5) {
    d = `M${fp.x},${fp.y} L${tp.x},${tp.y}`;
  } else {
    const midY = (fp.y + tp.y) / 2;
    const r = Math.min(8, Math.abs(tp.y - fp.y) / 3);
    const sign = tp.x > fp.x ? 1 : -1;
    d = [`M${fp.x},${fp.y}`, `V${midY - r}`, `Q${fp.x},${midY} ${fp.x + sign * r},${midY}`, `H${tp.x - sign * r}`, `Q${tp.x},${midY} ${tp.x},${midY + r}`, `V${tp.y}`].join(' ');
  }
  el('path', { d, stroke: '#6b7280', 'stroke-width': 1.5, fill: 'none', 'marker-end': 'url(#epc-arrow)' }, svg);
}

// ── Side connection (horizontal dashed line between function and side element) ─
function drawSideEdge(svg: Element, funcId: string, sideId: string, isOutput: boolean,
  nodeMap: Record<string, WorkflowElement>, pos: Record<string, { x: number; y: number }>) {
  const fp = pos[funcId]; const sp = pos[sideId]; if (!fp || !sp) return;
  const funcCY = fp.y + NODE_H / 2;
  const sideCY = sp.y + NODE_H / 2;
  // horizontal line from function edge to side element edge
  const x1 = isOutput ? fp.x + NODE_W : fp.x;
  const x2 = isOutput ? sp.x : sp.x + SIDE_W;
  const y1 = funcCY, y2 = sideCY;
  if (Math.abs(y1 - y2) < 2) {
    el('line', { x1, y1, x2, y2, stroke: '#9ca3af', 'stroke-width': 1, 'stroke-dasharray': '4 3' }, svg);
  } else {
    // elbow
    const mx = isOutput ? Math.min(x1, x2) + Math.abs(x2 - x1) / 2 : Math.max(x1, x2) - Math.abs(x2 - x1) / 2;
    el('polyline', { points: `${x1},${y1} ${mx},${y1} ${mx},${y2} ${x2},${y2}`, stroke: '#9ca3af', 'stroke-width': 1, 'stroke-dasharray': '4 3', fill: 'none' }, svg);
  }
  // arrow head at side element side
  const ax = isOutput ? x2 : x2;
  const dir = isOutput ? 1 : -1;
  el('polygon', { points: `${ax},${y2} ${ax - dir * 6},${y2 - 4} ${ax - dir * 6},${y2 + 4}`, fill: '#9ca3af' }, svg);
}

// ── Main render function ──────────────────────────────────────────────────────
function renderProcessSvg(wf: Workflow, caseData?: Case): SVGSVGElement {
  const { elements, flow } = wf;
  if (!elements || elements.length === 0) {
    const svg = el('svg', { width: 300, height: 60 }) as SVGSVGElement;
    const t = el('text', { x: 150, y: 30, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 13, fill: '#94a3b8', 'font-family': 'system-ui,sans-serif' }, svg);
    t.textContent = 'Empty process — add elements via editor';
    return svg as SVGSVGElement;
  }
  const statusMap: Record<string, string> = {};
  if (caseData) {
    (caseData.history || []).forEach(h => { if ((h as any).node_id) statusMap[(h as any).node_id] = 'completed'; });
    if (caseData.position) statusMap[caseData.position] = 'running';
  }
  const nodeMap: Record<string, WorkflowElement> = {};
  elements.forEach(e => { nodeMap[e.id] = e; });
  const layer = assignLayers(elements, flow);
  const { positions, canvasWidth, canvasHeight, sideRight, sideLeft } = computeLayout(elements, flow, layer);

  const svg = el('svg', { width: canvasWidth, height: canvasHeight, viewBox: `0 0 ${canvasWidth} ${canvasHeight}`, style: 'display:block;max-width:100%;height:auto;' }) as SVGSVGElement;
  const defs = el('defs', {}, svg);
  const marker = el('marker', { id: 'epc-arrow', markerWidth: 8, markerHeight: 8, refX: 7, refY: 3, orient: 'auto' }, defs);
  el('path', { d: 'M0,0 L0,6 L8,3 z', fill: '#6b7280' }, marker);
  const style = el('style', {}, defs);
  style.textContent = `@keyframes epc-pulse{0%{stroke-width:3;stroke-opacity:1}50%{stroke-width:5;stroke-opacity:.55}100%{stroke-width:3;stroke-opacity:1}}.epc-running{animation:epc-pulse 1.4s ease-in-out infinite}@keyframes epc-error-flash{0%,100%{stroke-opacity:1}50%{stroke-opacity:.4}}.epc-error{animation:epc-error-flash .8s step-start infinite}`;

  const edgeLayer = el('g', { id: 'edges' }, svg);
  // Draw main flow edges (skip side element connections - handled separately)
  flow.forEach(([from, to]) => {
    if (!positions[from] || !positions[to]) return;
    const fromSide = isSide(nodeMap[from]);
    const toSide = isSide(nodeMap[to]);
    if (fromSide || toSide) return; // side connections drawn separately
    drawEdge(edgeLayer, from, to, nodeMap, positions);
  });

  // Draw side element connections
  Object.entries(sideRight).forEach(([funcId, sids]) => {
    sids.forEach(sid => drawSideEdge(edgeLayer, funcId, sid, true, nodeMap, positions));
  });
  Object.entries(sideLeft).forEach(([funcId, sids]) => {
    sids.forEach(sid => drawSideEdge(edgeLayer, funcId, sid, false, nodeMap, positions));
  });

  const nodeLayer = el('g', { id: 'nodes' }, svg);
  elements.forEach(node => {
    const pos = positions[node.id];
    if (!pos) return;
    const s = STATUS_STYLE[statusMap[node.id]] || {};
    // Use SIDE_W for side elements
    const w = isSide(node) ? SIDE_W : NODE_W;
    const g = el('g', { transform: `translate(${pos.x},${pos.y})`, 'data-node-id': node.id, 'data-node-type': node.type }, nodeLayer);
    // Temporarily override NODE_W for side elements by passing width in a wrapper approach
    if (isSide(node)) {
      drawNodeScaled(g, node, s, SIDE_W);
    } else {
      drawNode(g, node, s);
    }
    if (statusMap[node.id] === 'error') {
      const t = el('text', { x: w - 4, y: 14, 'text-anchor': 'end', 'font-size': 14, 'pointer-events': 'none' }, g);
      t.textContent = '⚠';
    }
  });

  return svg as SVGSVGElement;
}

// ── React component ───────────────────────────────────────────────────────────
interface EpcRendererProps {
  workflow: Workflow;
  caseData?: Case;
}

export function EpcRenderer({ workflow, caseData }: EpcRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = '';
    try {
      const svg = renderProcessSvg(workflow, caseData);
      container.appendChild(svg);
    } catch (e: any) {
      container.innerHTML = `<div style="color:#ef4444;font-size:13px">Render error: ${e.message}</div>`;
    }
  }, [workflow, caseData]);

  return <div ref={containerRef} />;
}
