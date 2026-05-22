import { useEffect, useMemo, useState } from 'react';
import type { Case, EventWait, OperatorArtifactMetadata, RoleDef, Run, RuntimeEffectRecord, RuntimeEvent, WorkItem, Workflow } from '../api/types';

const STORAGE_KEY = 'konoha.operatorView.showHiddenArtifacts';

const HIDDEN_VISIBILITY = new Set(['debug', 'internal', 'test', 'generated', 'deprecated']);
const HIDDEN_SOURCE = new Set(['test', 'e2e', 'playwright', 'testbench', 'operator_eval']);
const HIDDEN_RETENTION_STATE = new Set(['archived', 'compacted']);
const LEGACY_TEST_ROLE_IDS = new Set(['tester', 'qa', 'reviewer']);

export interface OperatorViewOptions {
  showHiddenArtifacts?: boolean;
}

type MetadataCarrier = {
  metadata?: OperatorArtifactMetadata;
  payload?: Record<string, unknown>;
};

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function arrayIncludesOperator(value: unknown): boolean {
  if (Array.isArray(value)) return value.map(normalize).includes('operator');
  return normalize(value) === 'operator';
}

export function getArtifactMetadata(item: MetadataCarrier): OperatorArtifactMetadata | undefined {
  if (item.metadata) return item.metadata;
  const payloadMetadata = item.payload?.metadata;
  if (payloadMetadata && typeof payloadMetadata === 'object' && !Array.isArray(payloadMetadata)) {
    return payloadMetadata as OperatorArtifactMetadata;
  }
  return undefined;
}

export function isHiddenByMetadata(item: MetadataCarrier): boolean {
  const metadata = getArtifactMetadata(item);
  if (!metadata) return false;
  if (metadata.operator_visible === false) return true;
  if (normalize(metadata.lifecycle) === 'deprecated') return true;
  if (HIDDEN_RETENTION_STATE.has(normalize(metadata.retention_state))) return true;
  if (HIDDEN_VISIBILITY.has(normalize(metadata.visibility))) return true;
  if (HIDDEN_SOURCE.has(normalize(metadata.source))) return true;
  if (metadata.tags?.map(normalize).some(tag => HIDDEN_VISIBILITY.has(tag) || HIDDEN_SOURCE.has(tag))) return true;

  const audience = metadata.audience;
  if (audience !== undefined && !arrayIncludesOperator(audience)) {
    const audiences = Array.isArray(audience) ? audience.map(normalize) : [normalize(audience)];
    if (audiences.some(a => a === 'debug' || a === 'test' || a === 'internal')) return true;
  }
  return false;
}

function isLegacyTestWorkflow(workflow: Workflow): boolean {
  const id = normalize(workflow.id);
  const name = normalize(workflow.name);
  const status = normalize(workflow.status);

  if (status === 'archived' || status === 'deprecated') return true;
  if (id.startsWith('e2e-') || id.startsWith('test-') || id.startsWith('tc-')) return true;
  if (id.includes('operator-eval') || id.includes('testbench')) return true;
  if (id.endsWith('-copy') || name.includes('(копия)') || name.includes('(copy)')) return true;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(workflow.id) && name.startsWith('draft ')) return true;
  return false;
}

function isLegacyTestRole(role: RoleDef): boolean {
  const id = normalize(role.role_id);
  if (id.startsWith('test-') || id.startsWith('e2e-')) return true;
  return LEGACY_TEST_ROLE_IDS.has(id);
}

function isLegacyTestRun(run: Run, hiddenProcessIds: Set<string>): boolean {
  const processId = normalize(run.process_id);
  const subject = normalize(run.subject);
  if (hiddenProcessIds.has(run.process_id)) return true;
  if (processId.startsWith('e2e-') || processId.startsWith('test-') || processId.startsWith('tc-')) return true;
  if (subject === 'test' || subject.startsWith('test ') || subject.includes(' e2e ')) return true;
  return false;
}

export function isWorkflowHiddenFromOperator(workflow: Workflow): boolean {
  return isHiddenByMetadata(workflow) || isLegacyTestWorkflow(workflow);
}

export function filterOperatorWorkflows(workflows: Workflow[], options: OperatorViewOptions = {}): Workflow[] {
  if (options.showHiddenArtifacts) return workflows;
  return workflows.filter(workflow => !isWorkflowHiddenFromOperator(workflow));
}

export function filterOperatorRoles(roles: RoleDef[], options: OperatorViewOptions = {}): RoleDef[] {
  if (options.showHiddenArtifacts) return roles;
  return roles.filter(role => !isHiddenByMetadata(role) && !isLegacyTestRole(role));
}

export function filterOperatorRuns(
  runs: Run[],
  hiddenProcessIds: Set<string>,
  options: OperatorViewOptions = {},
): Run[] {
  if (options.showHiddenArtifacts) return runs;
  return runs.filter(run => !isHiddenByMetadata(run) && !isLegacyTestRun(run, hiddenProcessIds));
}

export function filterOperatorCases(
  cases: Case[],
  hiddenProcessIds: Set<string>,
  options: OperatorViewOptions = {},
): Case[] {
  return filterOperatorRuns(cases, hiddenProcessIds, options);
}

export function filterOperatorEvents(
  events: RuntimeEvent[],
  hiddenProcessIds: Set<string>,
  options: OperatorViewOptions = {},
): RuntimeEvent[] {
  if (options.showHiddenArtifacts) return events;
  return events.filter(event => {
    if (isHiddenByMetadata(event)) return false;
    if (event.process_id && hiddenProcessIds.has(event.process_id)) return false;
    const type = normalize(event.type);
    return !(type.startsWith('test.') || type.startsWith('e2e.'));
  });
}

function isHiddenProcessScoped(item: { process_id?: string | null } & MetadataCarrier, hiddenProcessIds: Set<string>): boolean {
  if (isHiddenByMetadata(item)) return true;
  return !!item.process_id && hiddenProcessIds.has(item.process_id);
}

function stringFrom(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function runtimeEffectProcessIds(effect: RuntimeEffectRecord): string[] {
  const payload = effect.payload || {};
  const subscription = payload.subscription && typeof payload.subscription === 'object' && !Array.isArray(payload.subscription)
    ? payload.subscription as Record<string, unknown>
    : {};
  const workItem = payload.work_item && typeof payload.work_item === 'object' && !Array.isArray(payload.work_item)
    ? payload.work_item as Record<string, unknown>
    : {};
  const candidates = [
    effect.links.workflow_id,
    stringFrom(payload.workflow_id),
    stringFrom(payload.process_id),
    stringFrom(subscription.workflow_id),
    stringFrom(subscription.process_id),
    stringFrom(workItem.workflow_id),
    stringFrom(workItem.process_id),
  ];
  return candidates.filter((value): value is string => !!value);
}

export function filterOperatorWorkItems(
  items: WorkItem[],
  hiddenProcessIds: Set<string>,
  options: OperatorViewOptions = {},
): WorkItem[] {
  if (options.showHiddenArtifacts) return items;
  return items.filter(item => !isHiddenProcessScoped(item, hiddenProcessIds));
}

export function filterOperatorWaits(
  waits: EventWait[],
  hiddenProcessIds: Set<string>,
  options: OperatorViewOptions = {},
): EventWait[] {
  if (options.showHiddenArtifacts) return waits;
  return waits.filter(wait => !isHiddenProcessScoped(wait, hiddenProcessIds));
}

export function filterOperatorRuntimeEffects(
  effects: RuntimeEffectRecord[],
  hiddenProcessIds: Set<string>,
  options: OperatorViewOptions = {},
): RuntimeEffectRecord[] {
  if (options.showHiddenArtifacts) return effects;
  return effects.filter(effect => {
    if (isHiddenByMetadata(effect)) return false;
    return !runtimeEffectProcessIds(effect).some(processId => hiddenProcessIds.has(processId));
  });
}

function urlForcesDebug(): boolean | null {
  if (typeof window === 'undefined') return null;
  const view = new URLSearchParams(window.location.search).get('view');
  if (view === 'debug' || view === 'all') return true;
  if (view === 'operator') return false;
  return null;
}

export function readShowHiddenArtifacts(): boolean {
  const forced = urlForcesDebug();
  if (forced !== null) return forced;
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(STORAGE_KEY) === 'true';
}

export function useOperatorViewMode() {
  const [showHiddenArtifacts, setShowHiddenArtifactsState] = useState(readShowHiddenArtifacts);

  useEffect(() => {
    const forced = urlForcesDebug();
    if (forced !== null) setShowHiddenArtifactsState(forced);
  }, []);

  const setShowHiddenArtifacts = (next: boolean) => {
    setShowHiddenArtifactsState(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    }
  };

  return useMemo(() => ({
    showHiddenArtifacts,
    setShowHiddenArtifacts,
  }), [showHiddenArtifacts]);
}
