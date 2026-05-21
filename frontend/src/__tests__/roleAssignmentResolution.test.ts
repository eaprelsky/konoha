import { describe, expect, test } from 'vitest';
import type { WorkflowValidationIssue } from '../api/types';
import {
  buildRoleAssigneeOptions,
  buildRoleAssignmentAction,
  extractRoleAssignmentIssue,
} from '../pages/roleAssignmentResolution';

const roleIssue: WorkflowValidationIssue = {
  code: 'ROLE_ASSIGNEE_UNRESOLVABLE',
  severity: 'error',
  class: 'role',
  message: 'Role cannot route',
  element_id: 'task',
  details: {
    role: 'sales_owner',
    strategy: 'load-balancing',
    assignees: ['offline-agent'],
  },
};

describe('role assignment resolution contract', () => {
  test('extracts role assignment data only from stable role validation codes', () => {
    expect(extractRoleAssignmentIssue(roleIssue)).toEqual({
      code: 'ROLE_ASSIGNEE_UNRESOLVABLE',
      role: 'sales_owner',
      element_id: 'task',
      current_assignees: ['offline-agent'],
      strategy: 'load-balancing',
    });

    expect(extractRoleAssignmentIssue({
      ...roleIssue,
      code: 'ADAPTER_MISSING',
      class: 'adapter',
    })).toBeNull();
  });

  test('maps unresolved role issues to role.create Action Spine payloads', () => {
    const action = buildRoleAssignmentAction(
      { code: 'ROLE_UNRESOLVABLE', role: 'sales_owner', current_assignees: [] },
      [],
      { mode: 'assign', assignee: 'sasuke' },
    );

    expect(action).toEqual({
      kind: 'create',
      role_id: 'sales_owner',
      payload: {
        role_id: 'sales_owner',
        name: 'sales_owner',
        assignees: ['sasuke'],
        strategy: 'round-robin',
      },
    });
  });

  test('maps existing role issues to role.update payloads and preserves non-manual strategy', () => {
    const action = buildRoleAssignmentAction(
      { code: 'ROLE_MISSING_ASSIGNEE', role: 'reviewer', current_assignees: [], strategy: 'round-robin' },
      [{ role_id: 'reviewer', name: 'Reviewer', assignees: [], strategy: 'load-balancing', created_at: '', updated_at: '' }],
      { mode: 'assign', assignee: 'kakashi' },
    );

    expect(action).toEqual({
      kind: 'update',
      role_id: 'reviewer',
      payload: {
        assignees: ['kakashi'],
        strategy: 'load-balancing',
      },
    });
  });

  test('maps manual queue resolution to manual strategy with no assignees', () => {
    const action = buildRoleAssignmentAction(
      { code: 'ROLE_MISSING_ASSIGNEE', role: 'reviewer', current_assignees: [], strategy: 'round-robin' },
      [{ role_id: 'reviewer', name: 'Reviewer', assignees: [], strategy: 'round-robin', created_at: '', updated_at: '' }],
      { mode: 'manual' },
    );

    expect(action).toEqual({
      kind: 'update',
      role_id: 'reviewer',
      payload: {
        assignees: [],
        strategy: 'manual',
      },
    });
  });

  test('uses only reachable agents and Telegram-capable people as assignment options', () => {
    const options = buildRoleAssigneeOptions(
      [
        { id: 'sasuke', name: 'Sasuke', status: 'online' },
        { id: 'shino', name: 'Shino', status: 'offline' },
      ] as any,
      [
        { id: 'person-1', name: 'Yegor', tg_id: 123, position: 'owner', tg_username: 'yegor' },
        { id: 'person-2', name: 'No Telegram', tg_id: 0, position: 'guest' },
      ] as any,
    );

    expect(options.map(option => option.id).sort()).toEqual(['person-1', 'sasuke']);
  });
});
