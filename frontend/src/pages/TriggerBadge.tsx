/**
 * TriggerBadge — inline SVG badge for event nodes showing trigger-resolver result.
 * Issue #412.
 */
import type { WorkflowElement } from '../api/types';
import { EW, EH } from './ArrowRouter';

type Trigger = NonNullable<WorkflowElement['trigger']>;

const KIND_ICON: Record<string, string> = {
  timer:     '⏱',
  message:   '✉',
  condition: '⚡',
  delay_after: '⏳',
  manual:    '👤',
  system:    '⚙',
  ambiguous: '?',
};

const KIND_SHORT: Record<string, string> = {
  timer:     'timer',
  message:   'msg',
  condition: 'cond',
  delay_after: 'delay',
  manual:    'manual',
  system:    'sys',
  ambiguous: '?',
};

function badgeColor(tr: Trigger | null | undefined, resolving: boolean): string {
  if (resolving)                    return '#6366f1';
  if (!tr || (!tr.kind && !tr.type)) return '#475569';
  if (tr.manual_override)           return '#d97706';
  if (tr.kind === 'ambiguous')      return '#dc2626';
  const c = tr.confidence;
  if (c == null) return '#475569';
  if (c > 0.8)   return '#16a34a';
  if (c > 0.5)   return '#d97706';
  return '#dc2626';
}

function triggerSummary(tr: Trigger | null | undefined, resolving: boolean): string {
  if (resolving) return '…';
  if (!tr || (!tr.kind && !tr.type)) return '?';
  if (tr.manual_override) return `🔒 ${KIND_SHORT[tr.kind ?? ''] ?? tr.kind ?? tr.type ?? '?'}`;
  const icon = KIND_ICON[tr.kind ?? ''] ?? '';
  const short = KIND_SHORT[tr.kind ?? ''] ?? tr.kind ?? tr.type ?? '?';
  const conf = tr.confidence != null ? ` ${Math.round(tr.confidence * 100)}%` : '';
  return `${icon} ${short}${conf}`;
}

interface Props {
  trigger: WorkflowElement['trigger'];
  resolving: boolean;
  isStartEvent: boolean;
  onClick: () => void;
}

const BADGE_W = 80;
const BADGE_H = 16;
const BADGE_X = (EW - BADGE_W) / 2;
const BADGE_Y = EH - BADGE_H - 2;

export function TriggerBadge({ trigger: tr, resolving, isStartEvent, onClick }: Props) {
  if (!isStartEvent) return null;

  const color = badgeColor(tr, resolving);
  const label = triggerSummary(tr, resolving);

  const tooltipParts: string[] = [];
  if (resolving) {
    tooltipParts.push('Определяю тип триггера…');
  } else if (!tr || (!tr.kind && !tr.type)) {
    tooltipParts.push('Триггер не определён — кликните для настройки');
  } else {
    if (tr.manual_override) tooltipParts.push('Тип задан вручную');
    if (tr.kind)            tooltipParts.push(`Тип: ${tr.kind}`);
    if (tr.confidence != null) tooltipParts.push(`Уверенность: ${Math.round(tr.confidence * 100)}%`);
    if (tr.kind === 'ambiguous' && tr.candidates?.length) {
      tooltipParts.push(`Варианты: ${tr.candidates.map(c => c.kind).join(', ')}`);
    }
    tooltipParts.push('Кликните для деталей и переопределения');
  }

  return (
    <g
      style={{ cursor: 'pointer' }}
      onClick={e => { e.stopPropagation(); onClick(); }}
    >
      <title>{tooltipParts.join(' · ')}</title>
      <rect
        x={BADGE_X} y={BADGE_Y}
        width={BADGE_W} height={BADGE_H}
        rx={8}
        fill={color}
        opacity={0.92}
      />
      <text
        x={EW / 2} y={BADGE_Y + BADGE_H / 2}
        textAnchor="middle" dominantBaseline="middle"
        fontSize={9} fill="white"
        fontFamily="system-ui,-apple-system,sans-serif"
        fontWeight="600"
        pointerEvents="none"
      >
        {label}
      </text>
    </g>
  );
}
