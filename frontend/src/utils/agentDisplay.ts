import type { Agent, RoleDef } from '../api/types';

export type AssigneeOption = { value: string; label: string };
type AgentDisplayFields = Pick<Agent, 'id' | 'name' | 'display_alias' | 'display'>;

export function agentDisplayName(agent: AgentDisplayFields): string {
  return agent.display?.name || agent.name || agent.id;
}

export function agentActorLabel(agent: AgentDisplayFields): string {
  const name = agentDisplayName(agent);
  const alias = (agent.display?.alias || agent.display_alias)?.trim();
  if (!alias || alias === name) return name;
  return `${name} (alias: ${alias})`;
}

export function agentAlias(agent: Pick<Agent, 'display_alias'>): string | undefined {
  return agent.display_alias || undefined;
}

export function buildAgentLabelMap(agents: Agent[]): Record<string, string> {
  return Object.fromEntries(agents.map(agent => [agent.id, agentActorLabel(agent)]));
}

export function buildRoleLabelMap(roles: RoleDef[]): Record<string, string> {
  const entries = roles.flatMap(role => [
    [role.role_id, role.name],
    [role.name, role.name],
  ] as const);
  return Object.fromEntries(entries);
}

export function formatAssignee(
  assignee: string | undefined,
  agentLabels: Record<string, string>,
  roleLabels: Record<string, string>,
  roleId?: string,
): string {
  if (!assignee) return '-';
  const agentLabel = agentLabels[assignee] || assignee;
  const roleLabel = roleId ? roleLabels[roleId] || roleId : roleLabels[assignee];
  if (roleLabel && roleId && roleId !== assignee) return `${roleLabel} -> ${agentLabel}`;
  return roleLabel || agentLabel;
}

export function roleAssigneeLabel(
  role: RoleDef,
  agentLabels: Record<string, string>,
): string {
  if (role.assignees.length === 0) return '';
  return role.assignees.map(id => agentLabels[id] || id).join(', ');
}
