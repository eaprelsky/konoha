/**
 * VersionSelector — toolbar version history dropdown.
 * Extracted from ProcessEditor.tsx (issue #330).
 */
import type React from 'react';
import { api } from '../api/client';
import { snap, EW, EH } from './ArrowRouter';
import type { WorkflowElement } from '../api/types';
import type { Pos } from './ArrowRouter';

interface Props {
  versions: { version: string; saved_at?: string }[];
  viewingVersion: string | null;
  wfId: string;
  onViewVersion: (v: string) => void;
  onResetVersion: () => void;
  onLoadPositions: (els: WorkflowElement[], pos: Record<string, Pos>) => void;
}

export function VersionSelector({ versions, viewingVersion, wfId, onViewVersion, onResetVersion, onLoadPositions }: Props) {
  if (versions.length <= 1) return null;

  return (
    <>
      <div className="sep" />
      <select
        style={{ padding: '4px 8px', background: '#1e293b', color: viewingVersion ? '#fbbf24' : '#94a3b8', border: '1px solid #475569', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}
        value={viewingVersion || ''}
        onChange={e => {
          const v = e.target.value;
          if (!v) { onResetVersion(); return; }
          onViewVersion(v);
          api.workflows.get(`${wfId}?snapshot=${v}`).then(vwf => {
            const pos: Record<string, Pos> = {};
            vwf.elements.forEach((el, i) => {
              if (typeof el.x === 'number' && typeof el.y === 'number' && (el.x !== 0 || el.y !== 0)) {
                pos[el.id] = { x: el.x, y: el.y };
              } else {
                const col = i % 6, row = Math.floor(i / 6);
                pos[el.id] = { x: snap(40 + col * (EW + 60)), y: snap(40 + row * (EH + 80)) };
              }
            });
            onLoadPositions(vwf.elements, pos);
          }).catch(() => {});
        }}
        title="История версий"
      >
        <option value="">📋 Текущая версия</option>
        {versions.map(v => (
          <option key={v.version} value={v.version}>
            #{v.version}{v.saved_at ? ` (${new Date(v.saved_at).toLocaleDateString('ru-RU')})` : ''}
          </option>
        ))}
      </select>
      {viewingVersion && (
        <span style={{ fontSize: 11, color: '#fbbf24' }}>👁 просмотр v{viewingVersion}</span>
      )}
    </>
  );
}
