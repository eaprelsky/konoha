import type { Agent } from '../../api/types';

export const SYSTEM_IDS = new Set(['naruto', 'sasuke', 'kakashi']);
export type AgentType = 'system' | 'external' | 'managed';

export const BUS_STATUS_LABELS: Record<string, string> = {
  online: 'онлайн',
  offline: 'офлайн',
};

export const LIFECYCLE_STATUS_LABELS: Record<string, string> = {
  running: 'работает',
  starting: 'запускается',
  stopped: 'остановлен',
  error: 'ошибка',
};

export function lifecycleColor(lc?: { status: string }): string {
  const s = lc?.status || '';
  if (s === 'running') return 'dot-running';
  if (s === 'starting') return 'dot-starting';
  if (s === 'error') return 'dot-error';
  if (s === 'stopped') return 'dot-stopped';
  return 'dot-offline';
}

export function busColor(status: string): string {
  if (status === 'online') return 'dot-online';
  return 'dot-offline';
}

export function formatUptime(sec?: number): string {
  if (!sec) return '';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function getAgentType(a: Agent): AgentType {
  if (SYSTEM_IDS.has(a.id)) return 'system';
  if (a.village_id && a.village_id !== 'comind.konoha') return 'external';
  return 'managed';
}
