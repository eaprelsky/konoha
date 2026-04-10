/**
 * Minimap — viewport overview overlay for ProcessEditor (issue #400).
 * Shows element positions and current visible area.
 */
import type { WorkflowElement } from '../api/types';
import type { Pos } from './ArrowRouter';
import { EW, EH } from './ArrowRouter';

interface Props {
  elements: WorkflowElement[];
  positions: Record<string, Pos>;
  panX: number;
  panY: number;
  zoom: number;
  svgRef: React.RefObject<SVGSVGElement>;
}

const MM_W = 160;
const MM_H = 100;
const PADDING = 40;

function elementFill(type: string): string {
  if (type === 'function')   return '#6366f1';
  if (type === 'event')      return '#10b981';
  if (type === 'gateway')    return '#f59e0b';
  if (type === 'role')       return '#3b82f6';
  if (type === 'document')   return '#8b5cf6';
  if (type === 'information_system') return '#06b6d4';
  return '#64748b';
}

export function Minimap({ elements, positions, panX, panY, zoom, svgRef }: Props) {
  if (elements.length === 0) return null;

  // Compute bounding box of all positioned elements
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    const p = positions[el.id];
    if (!p) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + EW);
    maxY = Math.max(maxY, p.y + EH);
  }
  if (!isFinite(minX)) return null;

  minX -= PADDING; minY -= PADDING;
  maxX += PADDING; maxY += PADDING;
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;

  // Scale to fit minimap preserving aspect ratio
  const scale = Math.min(MM_W / bboxW, MM_H / bboxH);
  const offsetX = (MM_W - bboxW * scale) / 2;
  const offsetY = (MM_H - bboxH * scale) / 2;

  // Viewport rect in world space
  const svg = svgRef.current;
  const svgW = svg?.clientWidth ?? 600;
  const svgH = svg?.clientHeight ?? 400;
  const vpX = -panX / zoom;
  const vpY = -panY / zoom;
  const vpW = svgW / zoom;
  const vpH = svgH / zoom;

  // Map to minimap coords
  const vx = (vpX - minX) * scale + offsetX;
  const vy = (vpY - minY) * scale + offsetY;
  const vw = Math.max(vpW * scale, 8);
  const vh = Math.max(vpH * scale, 8);

  return (
    <div style={{
      position: 'absolute',
      top: 12,
      right: 12,
      width: MM_W,
      height: MM_H,
      background: 'rgba(15,23,42,0.88)',
      border: '1px solid #334155',
      borderRadius: 6,
      overflow: 'hidden',
      pointerEvents: 'none',
      zIndex: 100,
    }}>
      <svg width={MM_W} height={MM_H}>
        {elements.map(el => {
          const p = positions[el.id];
          if (!p) return null;
          const ex = (p.x - minX) * scale + offsetX;
          const ey = (p.y - minY) * scale + offsetY;
          const ew = Math.max(EW * scale, 3);
          const eh = Math.max(EH * scale, 3);
          return (
            <rect key={el.id}
              x={ex} y={ey} width={ew} height={eh}
              fill={elementFill(el.type)} rx={1} opacity={0.75}
            />
          );
        })}
        {/* Viewport indicator */}
        <rect
          x={vx} y={vy} width={vw} height={vh}
          fill="rgba(99,102,241,0.12)"
          stroke="#6366f1"
          strokeWidth={1.5}
          rx={2}
        />
      </svg>
    </div>
  );
}
