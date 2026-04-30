import { describe, expect, it } from 'vitest';
import {
  agentActorLabel,
  agentDisplayName,
  buildAgentLabelMap,
  formatAssignee,
  roleAssigneeLabel,
} from '../utils/agentDisplay';
import type { Agent, RoleDef } from '../api/types';

const sasuke = {
  id: 'sasuke',
  name: 'Юзер-агент',
  display_alias: 'Саске',
  status: 'online',
} satisfies Agent;

const intakeRole = {
  role_id: 'sales_intake_triage',
  name: 'Разбор входящих лидов',
  description: 'Квалификация и маршрутизация входящих лидов.',
  assignees: ['sasuke'],
  strategy: 'manual',
} satisfies RoleDef;

describe('agent display helpers', () => {
  it('keeps canonical name separate from mutable alias', () => {
    expect(agentDisplayName(sasuke)).toBe('Юзер-агент');
    expect(agentActorLabel(sasuke)).toBe('Юзер-агент (alias: Саске)');
  });

  it('omits alias suffix when alias is absent or equal to name', () => {
    expect(agentActorLabel({ id: 'advisor', name: 'Советник', status: 'online' })).toBe('Советник');
    expect(agentActorLabel({ id: 'advisor', name: 'Советник', display_alias: 'Советник', status: 'online' })).toBe('Советник');
  });

  it('formats role to actor assignments without leaking runtime id as the label', () => {
    const agentLabels = buildAgentLabelMap([sasuke]);
    const roleLabels = { [intakeRole.role_id]: intakeRole.name };

    expect(roleAssigneeLabel(intakeRole, agentLabels)).toBe('Юзер-агент (alias: Саске)');
    expect(formatAssignee('sasuke', agentLabels, roleLabels, intakeRole.role_id))
      .toBe('Разбор входящих лидов -> Юзер-агент (alias: Саске)');
  });
});
