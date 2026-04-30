import type { Workflow } from '../api/types';

export function workflowDisplayName(workflow: Pick<Workflow, 'id' | 'name'>): string {
  return workflow.name || workflow.id;
}

export function workflowTitle(workflow: Pick<Workflow, 'id' | 'name'>): string {
  return workflow.name && workflow.name !== workflow.id
    ? `${workflow.name} (${workflow.id})`
    : workflow.id;
}

export function workflowMatchesSearch(workflow: Pick<Workflow, 'id' | 'name'>, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return [workflow.name, workflow.id]
    .filter(Boolean)
    .some(value => value.toLowerCase().includes(query));
}
