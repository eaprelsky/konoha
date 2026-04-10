/**
 * MiningOverlay — SVG badge overlay for process mining statistics on elements.
 * Extracted from ProcessEditor.tsx (issue #289).
 */
import type { WorkflowElement, ProcessMiningData } from '@core/api/types';
import { EW, EH } from './ArrowRouter';

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

interface MiningOverlayProps {
  el: WorkflowElement;
  miningData: ProcessMiningData;
}

/**
 * Renders visit count, duration, and bottleneck/deviation indicators
 * as SVG overlays on top of a process element.
 * Rendered inside an element's <g transform="translate(x,y)"> group.
 */
export function MiningOverlay({ el, miningData }: MiningOverlayProps) {
  const stat = miningData.elements[el.id];
  const isBottleneck = miningData.bottleneck_element_id === el.id;
  const isDeviation = miningData.deviation_elements.includes(el.id);
  const isSkipped = miningData.skipped_elements.includes(el.id);
  if (!stat && !isSkipped) return null;

  const visits = stat?.visit_count ?? 0;
  const avgMs = stat?.avg_duration_ms ?? null;
  const glowColor = isBottleneck ? '#ef4444' : isDeviation ? '#f59e0b' : null;

  return (
    <g className="mining-badge">
      {glowColor && (
        <rect x={-3} y={-3} width={EW + 6} height={EH + 6}
          rx={el.type === 'gateway' ? EH / 2 + 3 : 12}
          fill="none" stroke={glowColor} strokeWidth={3} opacity={0.6} />
      )}
      <rect x={0} y={0} width={28} height={16} rx={4}
        fill={visits > 0 ? '#1e40af' : '#374151'} opacity={0.9} />
      <text x={14} y={8} textAnchor="middle" dominantBaseline="middle"
        fontSize={9} fill="white">
        {visits > 0 ? `×${visits}` : 'skip'}
      </text>
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
}
