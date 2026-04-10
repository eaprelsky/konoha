/**
 * ArrowRouter — pure routing functions for SVG connectors in ProcessEditor.
 * Extracted from ProcessEditor.tsx (issue #289).
 */

// Canvas constants shared with element rendering
export const EW = 160;  // element width
export const EH = 58;   // element height
export const GR = 24;   // gateway radius
export const HD = 20;   // hexagon indent (event)
export const CW = 1600; // canvas width
export const CH = 960;  // canvas height

export const CORNER_R = 10;

export type Pos = { x: number; y: number };
export type EType = 'event' | 'function' | 'gateway' | 'role' | 'executor' | 'document' | 'information_system' | 'system';

/** Vertical-Horizontal-Vertical path with rounded corners */
export function routeVHV(x1: number, y1: number, x2: number, y2: number, midY: number): string {
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

/** Horizontal-Vertical-Horizontal path with rounded corners */
export function routeHVH(x1: number, y1: number, x2: number, y2: number, midX: number): string {
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

/** Choose VHV or HVH based on element positions; snaps to edge midpoints */
export function orthogonalPath(fp: Pos, tp: Pos, fromType?: EType, toType?: EType): string {
  const fcx = fp.x + EW / 2, fcy = fp.y + EH / 2;
  const tcx = tp.x + EW / 2, tcy = tp.y + EH / 2;
  const dx = tcx - fcx, dy = tcy - fcy;
  const vert = Math.abs(dy) >= Math.abs(dx);

  let x1: number, y1: number, x2: number, y2: number;

  if (fromType === 'gateway') {
    if (vert) { x1 = fcx; y1 = fcy + (dy >= 0 ? GR : -GR); }
    else      { x1 = fcx + (dx >= 0 ? GR : -GR); y1 = fcy; }
  } else {
    if (vert) { x1 = fcx; y1 = dy >= 0 ? fp.y + EH : fp.y; }
    else      { x1 = dx >= 0 ? fp.x + EW : fp.x; y1 = fcy; }
  }

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

export function snap(v: number, g = 20): number { return Math.round(v / g) * g; }

export function pinchDist(touches: TouchList): number {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

export function genId(type: EType, els: { id: string }[]): string {
  const p = type.replace('_', '-');
  const nums = els.filter(e => e.id.startsWith(p + '-'))
    .map(e => parseInt(e.id.split('-').pop() || '0', 10));
  return `${p}-${nums.length ? Math.max(...nums) + 1 : 1}`;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
