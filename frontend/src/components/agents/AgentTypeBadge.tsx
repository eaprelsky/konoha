import type { AgentType } from './agentUtils';

export function AgentTypeBadge({ type }: { type: AgentType }) {
  if (type === 'core')       return <span className="badge-system">Ядро</span>;
  if (type === 'connector')  return <span className="badge-external">Коннектор</span>;
  if (type === 'optional')   return <span className="badge-managed">Воркер</span>;
  if (type === 'deprecated') return <span className="badge-external">Совместимость</span>;
  if (type === 'external')   return <span className="badge-external">Внешний</span>;
  return <span className="badge-managed">Управляемый</span>;
}
