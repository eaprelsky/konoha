/**
 * epc-renderer.js — KWE-014: eEPC SVG Renderer
 * Renders eEPC process diagrams from JSON process definitions.
 * Self-contained, no framework dependencies.
 * @version 1.0.0
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.EpcRenderer = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // ── Layout constants ────────────────────────────────────────────────────────
  const NODE_W   = 180;   // node bounding-box width
  const NODE_H   =  60;   // node bounding-box height
  const GW_R     =  28;   // gateway circle radius
  const H_GAP    =  50;   // horizontal gap between siblings in same layer
  const V_GAP    =  90;   // vertical gap between layers
  const PADDING  =  30;   // canvas padding

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ── Case status styling ─────────────────────────────────────────────────────
  const STATUS_STYLE = {
    completed:   { stroke: '#22c55e', strokeWidth: 2,   opacity: 1.0, fillOverride: null,      dashArray: null,   cls: '' },
    running:     { stroke: '#f59e0b', strokeWidth: 3,   opacity: 1.0, fillOverride: null,      dashArray: null,   cls: 'epc-running' },
    waiting:     { stroke: '#9ca3af', strokeWidth: 1.5, opacity: 1.0, fillOverride: '#d1d5db', dashArray: '5 3',  cls: '' },
    error:       { stroke: '#ef4444', strokeWidth: 3,   opacity: 1.0, fillOverride: null,      dashArray: null,   cls: 'epc-error' },
    not_reached: { stroke: null,      strokeWidth: 0.5, opacity: 0.4, fillOverride: null,      dashArray: null,   cls: '' },
  };

  const DEFAULT_STYLE = { stroke: null, strokeWidth: null, opacity: 1.0, fillOverride: null, dashArray: null, cls: '' };

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v !== null && v !== undefined) e.setAttribute(k, v);
    }
    if (parent) parent.appendChild(e);
    return e;
  }

  function applyStatus(shape, style) {
    if (style.stroke)       shape.setAttribute('stroke', style.stroke);
    if (style.strokeWidth)  shape.setAttribute('stroke-width', style.strokeWidth);
    if (style.opacity !== 1.0) shape.setAttribute('opacity', style.opacity);
    if (style.fillOverride) shape.setAttribute('fill', style.fillOverride);
    if (style.dashArray)    shape.setAttribute('stroke-dasharray', style.dashArray);
    if (style.cls)          shape.setAttribute('class', style.cls);
  }

  /** Wrap text into multiple <tspan> lines within `maxWidth` pixels. */
  function addLabel(g, text, cx, cy, maxWidth) {
    const words  = String(text).split(' ');
    const lineH  = 14;
    const charW  = 6.5; // approximate char width for 12px font
    const lines  = [];
    let cur      = '';
    for (const w of words) {
      const candidate = cur ? cur + ' ' + w : w;
      if (candidate.length * charW > maxWidth && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = candidate;
      }
    }
    if (cur) lines.push(cur);

    const startY = cy - ((lines.length - 1) * lineH) / 2;
    lines.forEach((line, i) => {
      el('text', {
        x: cx, y: startY + i * lineH,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        'font-size': 12,
        'font-family': 'system-ui, -apple-system, sans-serif',
        fill: '#1a1a1a',
        'pointer-events': 'none',
      }, g).textContent = line;
    });
  }

  // ── Shape renderers ─────────────────────────────────────────────────────────

  function renderEvent(g, node, style) {
    const W = NODE_W, H = NODE_H, D = 25;
    const shape = el('polygon', {
      points: `${D},0 ${W-D},0 ${W},${H/2} ${W-D},${H} ${D},${H} 0,${H/2}`,
      fill:   '#F5C4B3',
      stroke: '#993C1D',
      'stroke-width': 0.5,
    }, g);
    applyStatus(shape, style);
    addLabel(g, node.label, W / 2, H / 2, W - D * 2 - 4);
  }

  function renderFunction(g, node, style) {
    const W = NODE_W, H = NODE_H;
    const shape = el('rect', {
      width: W, height: H, rx: 12,
      fill:   '#C0DD97',
      stroke: '#3B6D11',
      'stroke-width': 0.5,
    }, g);
    applyStatus(shape, style);
    addLabel(g, node.label, W / 2, H / 2, W - 24);

    // Role side-element: small organizational unit figure attached to the right
    if (node.role) {
      const RW = 68, RH = 32, GAP = 12;
      // Dashed connector line from right center of function to role element
      el('line', {
        x1: W, y1: H / 2,
        x2: W + GAP, y2: H / 2,
        stroke: '#9ca3af', 'stroke-width': 1,
        'stroke-dasharray': '3 2',
        'pointer-events': 'none',
      }, g);
      // Role oval (organizational unit shape)
      const rg = el('g', { transform: `translate(${W + GAP}, ${(H - RH) / 2})` }, g);
      el('ellipse', {
        cx: RW / 2, cy: RH / 2, rx: RW / 2 - 1, ry: RH / 2 - 1,
        fill: '#FFF9C4', stroke: '#B7A000', 'stroke-width': 1,
      }, rg);
      el('line', { x1: 10, y1: 3, x2: 10, y2: RH - 3, stroke: '#B7A000', 'stroke-width': 1.5 }, rg);
      el('text', {
        x: RW / 2 + 4, y: RH / 2,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        'font-size': 9,
        'font-family': 'system-ui, sans-serif',
        fill: '#78600a',
        'pointer-events': 'none',
      }, rg).textContent = node.role;
    }
  }

  function renderGateway(g, node, style) {
    const CX = NODE_W / 2, CY = NODE_H / 2;
    const shape = el('circle', {
      cx: CX, cy: CY, r: GW_R,
      fill:   '#E8F4FD',
      stroke: '#4B7BA8',
      'stroke-width': 1.5,
    }, g);
    applyStatus(shape, style);

    el('text', {
      x: CX, y: CY,
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      'font-size': 13,
      'font-weight': 'bold',
      'font-family': 'system-ui, sans-serif',
      fill: '#2c5f8a',
      'pointer-events': 'none',
    }, g).textContent = node.operator || node.label || '?';
  }

  function renderRole(g, node, style) {
    const W = NODE_W, H = NODE_H;
    // Yellow oval with a vertical line at left edge
    const shape = el('ellipse', {
      cx: W / 2, cy: H / 2, rx: W / 2 - 2, ry: H / 2 - 2,
      fill:   '#FFF9C4',
      stroke: '#B7A000',
      'stroke-width': 1,
    }, g);
    applyStatus(shape, style);
    el('line', { x1: 14, y1: 4, x2: 14, y2: H - 4, stroke: '#B7A000', 'stroke-width': 1.5 }, g);
    addLabel(g, node.label, W / 2 + 4, H / 2, W - 30);
  }

  function renderDocument(g, node, style) {
    const W = NODE_W, H = NODE_H;
    // Blue rect with a wavy bottom side (approximated as a path)
    const wave = `M0,${H-10} Q${W/4},${H+4} ${W/2},${H-10} Q${3*W/4},${H-24} ${W},${H-10} L${W},0 L0,0 Z`;
    const shape = el('path', {
      d: wave,
      fill:   '#DBEAFE',
      stroke: '#3B82F6',
      'stroke-width': 1,
    }, g);
    applyStatus(shape, style);
    addLabel(g, node.label, W / 2, (H - 10) / 2, W - 16);
  }

  function renderInfoSystem(g, node, style) {
    const W = NODE_W, H = NODE_H;
    // Light-blue rect with double vertical borders
    const shape = el('rect', {
      width: W, height: H,
      fill:   '#E0F2FE',
      stroke: '#0EA5E9',
      'stroke-width': 1,
    }, g);
    applyStatus(shape, style);
    // Inner vertical border lines
    el('line', { x1: 6,   y1: 2, x2: 6,   y2: H - 2, stroke: '#0EA5E9', 'stroke-width': 1 }, g);
    el('line', { x1: W-6, y1: 2, x2: W-6, y2: H - 2, stroke: '#0EA5E9', 'stroke-width': 1 }, g);
    addLabel(g, node.label, W / 2, H / 2, W - 28);
  }

  function renderFallback(g, node, style) {
    const W = NODE_W, H = NODE_H;
    const shape = el('rect', {
      width: W, height: H,
      fill:   '#f3f4f6',
      stroke: '#9ca3af',
      'stroke-width': 1,
    }, g);
    applyStatus(shape, style);
    addLabel(g, node.label, W / 2, H / 2, W - 16);
  }

  function drawNode(g, node, style) {
    switch (node.type) {
      case 'event':               return renderEvent(g, node, style);
      case 'function':            return renderFunction(g, node, style);
      case 'gateway':             return renderGateway(g, node, style);
      case 'role':                return renderRole(g, node, style);
      case 'document':            return renderDocument(g, node, style);
      case 'information_system':
      case 'system':              return renderInfoSystem(g, node, style);
      default:                    return renderFallback(g, node, style);
    }
  }

  // ── Layout ──────────────────────────────────────────────────────────────────

  /**
   * Assigns each node a layer index (0 = top) using longest-path layering.
   * Nodes with no predecessors get layer 0.
   */
  function assignLayers(elements, flow) {
    const inCount  = {};
    const outEdges = {};
    elements.forEach(e => { inCount[e.id] = 0; outEdges[e.id] = []; });
    flow.forEach(([from, to]) => {
      outEdges[from].push(to);
      inCount[to] = (inCount[to] || 0) + 1;
    });

    const layer = {};
    const queue = elements.filter(e => !inCount[e.id]).map(e => e.id);
    queue.forEach(id => { layer[id] = 0; });

    let head = 0;
    while (head < queue.length) {
      const id = queue[head++];
      for (const to of (outEdges[id] || [])) {
        const proposed = layer[id] + 1;
        if (layer[to] === undefined || layer[to] < proposed) {
          layer[to] = proposed;
          queue.push(to);
        }
      }
    }
    // Any disconnected nodes get layer 0
    elements.forEach(e => { if (layer[e.id] === undefined) layer[e.id] = 0; });
    return layer;
  }

  /**
   * Computes {x, y} positions for each node id.
   * Nodes in the same layer are spaced horizontally; layers are stacked vertically.
   * Returns { positions, canvasWidth, canvasHeight }.
   */
  function computeLayout(elements, layer) {
    const byLayer = {};
    elements.forEach(e => {
      const l = layer[e.id];
      if (!byLayer[l]) byLayer[l] = [];
      byLayer[l].push(e.id);
    });

    const numLayers = Math.max(...Object.keys(byLayer).map(Number)) + 1;

    // Compute per-layer widths
    let maxLayerWidth = 0;
    Object.values(byLayer).forEach(ids => {
      const w = ids.length * NODE_W + (ids.length - 1) * H_GAP;
      if (w > maxLayerWidth) maxLayerWidth = w;
    });

    const canvasWidth  = maxLayerWidth + PADDING * 2;
    const canvasHeight = numLayers * NODE_H + (numLayers - 1) * V_GAP + PADDING * 2;

    const positions = {};
    Object.entries(byLayer).forEach(([layerStr, ids]) => {
      const l = parseInt(layerStr);
      const totalW = ids.length * NODE_W + (ids.length - 1) * H_GAP;
      const startX = (canvasWidth - totalW) / 2;
      ids.forEach((id, i) => {
        positions[id] = {
          x: startX + i * (NODE_W + H_GAP),
          y: PADDING + l * (NODE_H + V_GAP),
        };
      });
    });

    return { positions, canvasWidth, canvasHeight };
  }

  // ── Edge routing ────────────────────────────────────────────────────────────

  /**
   * Returns the bottom-center connection point of a node's bounding box.
   * For gateways the bottom of the circle is used.
   */
  function bottomOf(nodeId, nodeMap, pos) {
    const n = nodeMap[nodeId];
    const p = pos[nodeId];
    const cx = p.x + NODE_W / 2;
    if (n && n.type === 'gateway') {
      return { x: cx, y: p.y + NODE_H / 2 + GW_R };
    }
    return { x: cx, y: p.y + NODE_H };
  }

  function topOf(nodeId, nodeMap, pos) {
    const n = nodeMap[nodeId];
    const p = pos[nodeId];
    const cx = p.x + NODE_W / 2;
    if (n && n.type === 'gateway') {
      return { x: cx, y: p.y + NODE_H / 2 - GW_R };
    }
    return { x: cx, y: p.y };
  }

  function drawEdge(svg, from, to, nodeMap, positions) {
    const fp = bottomOf(from, nodeMap, positions);
    const tp = topOf(to, nodeMap, positions);

    let d;
    if (Math.abs(fp.x - tp.x) < 0.5) {
      // Same x: straight vertical line
      d = `M${fp.x},${fp.y} L${tp.x},${tp.y}`;
    } else {
      // Orthogonal routing: down → horizontal → down, with rounded corners
      const midY = (fp.y + tp.y) / 2;
      const r = Math.min(8, Math.abs(tp.y - fp.y) / 3);
      const sign = tp.x > fp.x ? 1 : -1;
      d = [
        `M${fp.x},${fp.y}`,
        `V${midY - r}`,
        `Q${fp.x},${midY} ${fp.x + sign * r},${midY}`,
        `H${tp.x - sign * r}`,
        `Q${tp.x},${midY} ${tp.x},${midY + r}`,
        `V${tp.y}`,
      ].join(' ');
    }

    el('path', {
      d,
      stroke: '#6b7280',
      'stroke-width': 1.5,
      fill: 'none',
      'marker-end': 'url(#epc-arrow)',
    }, svg);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Renders an eEPC process diagram into `container`.
   *
   * @param {Object}      definition  - Process definition { id, elements[], flow[] }
   * @param {HTMLElement} container   - DOM element to render into (cleared first)
   * @param {Object}      [options]
   * @param {Object}      [options.case]  - Case object with { history[], position } for status highlighting
   */
  function renderProcess(definition, container, options) {
    options = options || {};
    const caseData = options.case || null;

    const { elements, flow } = definition;
    if (!elements || !flow) throw new Error('definition must have elements[] and flow[]');

    // Build case status map
    const statusMap = {};
    if (caseData) {
      (caseData.history || []).forEach(step => {
        if (step.node_id) statusMap[step.node_id] = step.status || 'completed';
      });
      if (caseData.position) {
        statusMap[caseData.position] = 'running';
      }
    }

    // Index elements
    const nodeMap = {};
    elements.forEach(e => { nodeMap[e.id] = e; });

    // Layout
    const layer     = assignLayers(elements, flow);
    const { positions, canvasWidth, canvasHeight } = computeLayout(elements, layer);

    // Build SVG root
    const svg = el('svg', {
      width:   canvasWidth,
      height:  canvasHeight,
      viewBox: `0 0 ${canvasWidth} ${canvasHeight}`,
      style:   'display:block; max-width:100%; height:auto;',
    });

    // Defs: arrow marker + keyframe animation
    const defs = el('defs', {}, svg);

    const marker = el('marker', {
      id: 'epc-arrow', markerWidth: 8, markerHeight: 8,
      refX: 7, refY: 3, orient: 'auto',
    }, defs);
    el('path', { d: 'M0,0 L0,6 L8,3 z', fill: '#6b7280' }, marker);

    const style = el('style', {}, defs);
    style.textContent = `
      @keyframes epc-pulse {
        0%   { stroke-width: 3; stroke-opacity: 1; }
        50%  { stroke-width: 5; stroke-opacity: 0.55; }
        100% { stroke-width: 3; stroke-opacity: 1; }
      }
      .epc-running { animation: epc-pulse 1.4s ease-in-out infinite; }
      @keyframes epc-error-flash {
        0%,100% { stroke-opacity: 1; }
        50%     { stroke-opacity: 0.4; }
      }
      .epc-error { animation: epc-error-flash 0.8s step-start infinite; }
    `;

    // Layer: edges (drawn first, below nodes)
    const edgeLayer = el('g', { id: 'edges' }, svg);
    flow.forEach(([from, to]) => {
      if (!positions[from] || !positions[to]) return;
      drawEdge(edgeLayer, from, to, nodeMap, positions);
    });

    // Layer: nodes
    const nodeLayer = el('g', { id: 'nodes' }, svg);
    elements.forEach(node => {
      const pos = positions[node.id];
      if (!pos) return;
      const status   = statusMap[node.id];
      const nodeStyle = STATUS_STYLE[status] || DEFAULT_STYLE;
      const g = el('g', {
        transform: `translate(${pos.x},${pos.y})`,
        'data-node-id':   node.id,
        'data-node-type': node.type,
      }, nodeLayer);
      drawNode(g, node, nodeStyle);

      // Error icon overlay
      if (status === 'error') {
        el('text', {
          x: NODE_W - 4, y: 14,
          'text-anchor': 'end',
          'font-size': 14,
          'pointer-events': 'none',
        }, g).textContent = '⚠';
      }
    });

    container.innerHTML = '';
    container.appendChild(svg);
  }

  return { renderProcess, VERSION: '1.0.0' };
}));
