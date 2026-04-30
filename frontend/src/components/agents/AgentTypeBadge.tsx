import type { AgentType } from './agentUtils';
import { useI18n } from '../../context/I18nContext';

const AGENT_TYPE_BADGES: Record<AgentType, { className: string; labelKey: string; fallback: string }> = {
  core: { className: 'badge-system', labelKey: 'agent.type.core', fallback: 'Core' },
  connector: { className: 'badge-external', labelKey: 'agent.type.connector', fallback: 'Connector' },
  optional: { className: 'badge-managed', labelKey: 'agent.type.optional', fallback: 'Worker' },
  deprecated: { className: 'badge-deprecated', labelKey: 'agent.type.deprecated', fallback: 'Compatibility' },
  external: { className: 'badge-external', labelKey: 'agent.type.external', fallback: 'External' },
  managed: { className: 'badge-managed', labelKey: 'agent.type.managed', fallback: 'Managed' },
};

export function AgentTypeBadge({ type }: { type: AgentType }) {
  const { t } = useI18n();
  const badge = AGENT_TYPE_BADGES[type] ?? AGENT_TYPE_BADGES.managed;
  return <span className={badge.className}>{t(badge.labelKey, badge.fallback)}</span>;
}
