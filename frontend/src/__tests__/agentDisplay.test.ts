import { describe, expect, it } from 'vitest';
import {
  agentActorLabel,
  agentDisplayName,
  buildAgentLabelMap,
  formatAssignee,
  roleAssigneeLabel,
} from '../utils/agentDisplay';
import { getAgentType as getLifecycleAgentType } from '../components/agents/agentUtils';
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
  created_at: '2026-04-30T00:00:00.000Z',
  updated_at: '2026-04-30T00:00:00.000Z',
} satisfies RoleDef;

describe('agent display helpers', () => {
  it('keeps canonical name separate from mutable alias', () => {
    expect(agentDisplayName(sasuke)).toBe('Юзер-агент');
    expect(agentActorLabel(sasuke)).toBe('Юзер-агент (alias: Саске)');
  });

  it('omits alias suffix when alias is absent or equal to name', () => {
    expect(agentActorLabel({ id: 'advisor', name: 'Советник' })).toBe('Советник');
    expect(agentActorLabel({ id: 'advisor', name: 'Советник', display_alias: 'Советник' })).toBe('Советник');
  });

  it('formats role to actor assignments without leaking runtime id as the label', () => {
    const agentLabels = buildAgentLabelMap([sasuke]);
    const roleLabels = { [intakeRole.role_id]: intakeRole.name };

    expect(roleAssigneeLabel(intakeRole, agentLabels)).toBe('Юзер-агент (alias: Саске)');
    expect(formatAssignee('sasuke', agentLabels, roleLabels, intakeRole.role_id))
      .toBe('Разбор входящих лидов -> Юзер-агент (alias: Саске)');
  });

  it('prefers resolved display catalog values over runtime defaults', () => {
    const agent = {
      id: 'kakashi',
      name: 'SDD lead',
      display_alias: 'Kakashi',
      status: 'offline',
      display: {
        name: 'Тимлид SDD',
        alias: 'Какаши',
        locale: 'ru',
        source: { name: 'locale_catalog' as const, alias: 'locale_catalog' as const },
      },
    } satisfies Agent;

    expect(agentDisplayName(agent)).toBe('Тимлид SDD');
    expect(agentActorLabel(agent)).toBe('Тимлид SDD (alias: Какаши)');
  });

  it('classifies lifecycle modes without hardcoded runtime ids', () => {
    expect(getLifecycleAgentType({ id: 'any-core', name: 'Советник', status: 'online', lifecycle_mode: 'core' }))
      .toBe('core');
    expect(getLifecycleAgentType({ id: 'naruto', name: 'Telegram bot connector', status: 'online', seed_classification: 'connector_owned' }))
      .toBe('connector');
    expect(getLifecycleAgentType({ id: 'kakashi', name: 'SDD тимлид', status: 'offline', seed_classification: 'optional_worker' }))
      .toBe('optional');
    expect(getLifecycleAgentType({ id: 'jiraiya', name: 'Куратор знаний', status: 'offline', lifecycle_mode: 'deprecated' }))
      .toBe('deprecated');
  });
});
