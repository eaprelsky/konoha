import type { Agent, AssignmentStrategy, Person, RoleDef, WorkflowValidationIssue } from '../api/types';

export const ROLE_ASSIGNMENT_ISSUE_CODES = new Set([
  'ROLE_UNRESOLVABLE',
  'ROLE_MISSING_ASSIGNEE',
  'ROLE_ASSIGNEE_UNRESOLVABLE',
]);

export type RoleAssignmentResolution =
  | { mode: 'assign'; assignee: string }
  | { mode: 'manual' };

export interface RoleAssignmentIssue {
  code: string;
  role: string;
  element_id?: string;
  current_assignees: string[];
  strategy?: string;
}

export interface RoleAssignmentAction {
  kind: 'create' | 'update';
  role_id: string;
  payload: {
    role_id?: string;
    name?: string;
    assignees: string[];
    strategy: AssignmentStrategy;
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function extractRoleAssignmentIssue(issue: WorkflowValidationIssue): RoleAssignmentIssue | null {
  if (issue.class !== 'role' || !ROLE_ASSIGNMENT_ISSUE_CODES.has(issue.code)) return null;
  const details = issue.details ?? {};
  const role = typeof details.role === 'string' && details.role.trim()
    ? details.role.trim()
    : null;
  if (!role) return null;
  return {
    code: issue.code,
    role,
    element_id: issue.element_id,
    current_assignees: stringList(details.assignees),
    strategy: typeof details.strategy === 'string' ? details.strategy : undefined,
  };
}

function isManualStrategy(value: unknown): value is AssignmentStrategy {
  return value === 'manual' || value === 'round-robin' || value === 'load-balancing' || value === 'broadcast';
}

export function buildRoleAssignmentAction(
  issue: RoleAssignmentIssue,
  roles: RoleDef[],
  resolution: RoleAssignmentResolution,
): RoleAssignmentAction {
  const existing = roles.find(role => role.role_id === issue.role);
  const strategy = resolution.mode === 'manual'
    ? 'manual'
    : isManualStrategy(existing?.strategy) && existing!.strategy !== 'manual'
      ? existing!.strategy
      : 'round-robin';
  const assignees = resolution.mode === 'manual' ? [] : [resolution.assignee];

  if (existing) {
    return {
      kind: 'update',
      role_id: issue.role,
      payload: { assignees, strategy },
    };
  }

  return {
    kind: 'create',
    role_id: issue.role,
    payload: {
      role_id: issue.role,
      name: issue.role,
      assignees,
      strategy,
    },
  };
}

export interface AssigneeOption {
  id: string;
  label: string;
  group: 'agents' | 'people';
  disabled?: boolean;
}

export function buildRoleAssigneeOptions(agents: Agent[], people: Person[]): AssigneeOption[] {
  const onlineAgents = agents
    .filter(agent => agent.status === undefined || agent.status === 'online')
    .map(agent => ({
      id: agent.id,
      label: agent.display?.name || agent.display_alias || agent.name || agent.id,
      group: 'agents' as const,
    }));
  const reachablePeople = people
    .filter(person => Boolean(person.tg_id))
    .map(person => ({
      id: person.id || person.tg_username || person.name,
      label: person.tg_username ? `${person.name} (@${person.tg_username})` : person.name,
      group: 'people' as const,
    }));
  return [...onlineAgents, ...reachablePeople].sort((a, b) => a.label.localeCompare(b.label));
}
