import type { AgentType } from './agentUtils';

export function AgentTypeBadge({ type }: { type: AgentType }) {
  if (type === 'system')   return <span className="badge-system">Системный</span>;
  if (type === 'external') return <span className="badge-external">Внешний</span>;
  return <span className="badge-managed">Управляемый</span>;
}
