/**
 * ElementShape — SVG shape renderer for eEPC process elements.
 * Extracted from ProcessEditor.tsx (issue #289).
 */
import type React from 'react';
import type { WorkflowElement } from '../api/types';
import { EW, EH, GR, HD, type EType } from './ArrowRouter';

export const PALETTE: { type: EType; label: string; fill: string; stroke: string }[] = [
  { type: 'event',              label: 'Событие',     fill: '#F5C4B3', stroke: '#993C1D' },
  { type: 'function',           label: 'Функция',     fill: '#C0DD97', stroke: '#3B6D11' },
  { type: 'gateway',            label: 'Ветвление',   fill: '#E8F4FD', stroke: '#4B7BA8' },
  { type: 'role',               label: 'Роль',        fill: '#FFF9C4', stroke: '#B7A000' },
  { type: 'executor',           label: 'Исполнитель', fill: '#FFE4CC', stroke: '#CC6600' },
  { type: 'document',           label: 'Документ',    fill: '#DBEAFE', stroke: '#3B82F6' },
  { type: 'information_system', label: 'IS',          fill: '#E0F2FE', stroke: '#0EA5E9' },
];

export const DEFAULT_LABELS: Record<EType, string> = {
  event:              'Новое событие',
  function:           'Новая функция',
  gateway:            'Новое ветвление',
  role:               'Новая роль',
  executor:           'Новый исполнитель',
  document:           'Новый документ',
  information_system: 'Новая ИС',
  system:             'Новая система',
};

interface ShapeProps {
  el: WorkflowElement;
  selected: boolean;
  connectSrc: boolean;
  isEditing?: boolean;
}

export function ElShape({ el, selected, connectSrc, isEditing }: ShapeProps) {
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
    case 'role': {
      const rcx = EW/2, rcy = EH/2, rrx = EW/2-2, rry = EH/2-2;
      const rt = (14 - rcx) / rrx;
      const rh = rry * Math.sqrt(Math.max(0, 1 - rt * rt));
      shape = <>
        <ellipse cx={rcx} cy={rcy} rx={rrx} ry={rry} fill={fill} stroke={outln} strokeWidth={sw} />
        <line x1={14} y1={rcy - rh} x2={14} y2={rcy + rh} stroke={outln} strokeWidth={1.5} />
      </>;
      break;
    }
    case 'executor':
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

  const gwOp = (el.operator || '').toUpperCase();
  const label = el.type === 'gateway'
    ? (gwOp === 'X' ? 'XOR' : gwOp === 'XOR' ? 'XOR' : gwOp === 'AND' ? 'AND' : gwOp === 'OR' ? 'OR' : el.operator || el.label)
    : el.label;
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
