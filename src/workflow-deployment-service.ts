import { redis } from "./redis";
import {
  SUBSCRIPTIONS_KEY,
  cancelSubscriptionResources,
  createSubscriptionProgrammatic,
} from "./events/subscriptions";
import type { Subscription, TriggerDef } from "./events/types";
import type { WorkflowDefinition, WorkflowElement } from "./workflow-loader";

export interface WorkflowDeploymentContext {
  deploy_version: number;
  deployed_at: string;
  deployed_by: string;
  source?: string;
}

export interface WorkflowDeploymentSubscriptionReceipt {
  event_id: string;
  event_label?: string;
  trigger_kind?: string;
  subscription_id?: string;
  previous_subscription_id?: string;
  operation_key: string;
  status: "created" | "cancelled" | "unchanged" | "failed";
  mode?: "auto" | "manual";
  reason?: string;
  error?: string;
}

export interface WorkflowDeploymentReceipt {
  ok: boolean;
  workflow_id: string;
  deploy_version: number;
  deployment_id: string;
  source: string;
  subscriptions: {
    desired: number;
    created: WorkflowDeploymentSubscriptionReceipt[];
    cancelled: WorkflowDeploymentSubscriptionReceipt[];
    unchanged: WorkflowDeploymentSubscriptionReceipt[];
    failed: WorkflowDeploymentSubscriptionReceipt[];
  };
}

interface DeploymentSubscriptionDeps {
  createSubscription: typeof createSubscriptionProgrammatic;
  cancelResources: typeof cancelSubscriptionResources;
}

const defaultDeps: DeploymentSubscriptionDeps = {
  createSubscription: createSubscriptionProgrammatic,
  cancelResources: cancelSubscriptionResources,
};

let activeDeps: DeploymentSubscriptionDeps = defaultDeps;

export function setWorkflowDeploymentSubscriptionDepsForTest(
  deps: Partial<DeploymentSubscriptionDeps>,
): () => void {
  activeDeps = { ...defaultDeps, ...deps };
  return () => {
    activeDeps = defaultDeps;
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function edgeTarget(edge: WorkflowDefinition["flow"][number]): string {
  return edge[1];
}

function deploymentId(workflowId: string, deployVersion: number): string {
  return `${workflowId}:v${deployVersion}`;
}

function operationKey(workflowId: string, deployVersion: number, eventId: string): string {
  return `${workflowId}:v${deployVersion}:${eventId}`;
}

function startEvents(def: WorkflowDefinition): WorkflowElement[] {
  const inCount = new Map<string, number>();
  for (const element of def.elements ?? []) inCount.set(element.id, 0);
  for (const edge of def.flow ?? []) {
    const target = edgeTarget(edge);
    inCount.set(target, (inCount.get(target) ?? 0) + 1);
  }
  return (def.elements ?? []).filter(element =>
    element.type === "event" &&
    (inCount.get(element.id) ?? 0) === 0 &&
    Boolean(element.trigger?.kind) &&
    !element.trigger?.manual_override,
  );
}

async function activeStartSubscriptions(workflowId: string): Promise<Subscription[]> {
  const all = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({} as Record<string, string>));
  const result: Subscription[] = [];
  for (const raw of Object.values(all)) {
    let subscription: Subscription;
    try {
      subscription = JSON.parse(raw);
    } catch {
      continue;
    }
    if (subscription.process_id === workflowId && subscription.instance_id === "new" && subscription.status === "active") {
      result.push(subscription);
    }
  }
  return result;
}

async function cancelSubscription(
  sub: Subscription,
  context: WorkflowDeploymentContext,
  reason: string,
  deps: DeploymentSubscriptionDeps,
): Promise<WorkflowDeploymentSubscriptionReceipt> {
  sub.status = "cancelled";
  await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));
  await deps.cancelResources(sub);
  return {
    event_id: sub.event_id,
    event_label: sub.event_label,
    trigger_kind: sub.trigger.kind,
    previous_subscription_id: sub.id,
    operation_key: operationKey(sub.process_id, context.deploy_version, sub.event_id),
    status: "cancelled",
    reason,
  };
}

async function markSubscriptionUnchanged(
  sub: Subscription,
  def: WorkflowDefinition,
  context: WorkflowDeploymentContext,
): Promise<WorkflowDeploymentSubscriptionReceipt> {
  const updated = {
    ...sub,
    process_name: def.name,
    deploy_version: context.deploy_version,
    deployment_id: deploymentId(def.id, context.deploy_version),
    operation_key: operationKey(def.id, context.deploy_version, sub.event_id),
    deployed_at: context.deployed_at,
    deployed_by: context.deployed_by,
  };
  await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(updated));
  return {
    event_id: sub.event_id,
    event_label: sub.event_label,
    trigger_kind: sub.trigger.kind,
    subscription_id: sub.id,
    operation_key: operationKey(def.id, context.deploy_version, sub.event_id),
    status: "unchanged",
    mode: sub.mode,
    reason: "matching_active_subscription",
  };
}

export async function materializeWorkflowDeploymentSubscriptions(
  def: WorkflowDefinition,
  context: WorkflowDeploymentContext,
  deps: DeploymentSubscriptionDeps = activeDeps,
): Promise<WorkflowDeploymentReceipt> {
  const deployment_id = deploymentId(def.id, context.deploy_version);
  const desiredEvents = startEvents(def);
  const desiredIds = new Set(desiredEvents.map(event => event.id));
  const active = await activeStartSubscriptions(def.id);
  const activeByEvent = new Map<string, Subscription[]>();
  for (const sub of active) {
    const list = activeByEvent.get(sub.event_id) ?? [];
    list.push(sub);
    activeByEvent.set(sub.event_id, list);
  }

  const created: WorkflowDeploymentSubscriptionReceipt[] = [];
  const cancelled: WorkflowDeploymentSubscriptionReceipt[] = [];
  const unchanged: WorkflowDeploymentSubscriptionReceipt[] = [];
  const failed: WorkflowDeploymentSubscriptionReceipt[] = [];

  for (const sub of active) {
    if (!desiredIds.has(sub.event_id)) {
      try {
        cancelled.push(await cancelSubscription(sub, context, "not_in_deployed_start_trigger_set", deps));
      } catch (e: any) {
        failed.push({
          event_id: sub.event_id,
          event_label: sub.event_label,
          trigger_kind: sub.trigger.kind,
          previous_subscription_id: sub.id,
          operation_key: operationKey(def.id, context.deploy_version, sub.event_id),
          status: "failed",
          reason: "cancel_obsolete_subscription_failed",
          error: e.message,
        });
      }
    }
  }

  for (const event of desiredEvents) {
    const trigger = event.trigger as TriggerDef;
    const operation_key = operationKey(def.id, context.deploy_version, event.id);
    const matchingActive = (activeByEvent.get(event.id) ?? []).filter(sub => sub.status === "active");
    const same = matchingActive.find(sub => stableStringify(sub.trigger) === stableStringify(trigger));
    const duplicates = matchingActive.filter(sub => sub !== same);

    for (const duplicate of duplicates) {
      try {
        cancelled.push(await cancelSubscription(duplicate, context, same ? "duplicate_active_subscription" : "trigger_changed", deps));
      } catch (e: any) {
        failed.push({
          event_id: event.id,
          event_label: event.label,
          trigger_kind: duplicate.trigger.kind,
          previous_subscription_id: duplicate.id,
          operation_key,
          status: "failed",
          reason: "cancel_duplicate_subscription_failed",
          error: e.message,
        });
      }
    }

    if (same) {
      try {
        unchanged.push(await markSubscriptionUnchanged(same, def, context));
      } catch (e: any) {
        failed.push({
          event_id: event.id,
          event_label: event.label,
          trigger_kind: trigger.kind,
          subscription_id: same.id,
          operation_key,
          status: "failed",
          reason: "refresh_subscription_metadata_failed",
          error: e.message,
        });
      }
      continue;
    }

    try {
      const createdSub = await deps.createSubscription({
        event_id: event.id,
        event_label: event.label,
        process_id: def.id,
        process_name: def.name,
        instance_id: "new",
        trigger,
        deploy_version: context.deploy_version,
        deployment_id,
        operation_key,
        deployed_at: context.deployed_at,
        deployed_by: context.deployed_by,
      });
      created.push({
        event_id: event.id,
        event_label: event.label,
        trigger_kind: trigger.kind,
        subscription_id: createdSub.subscription_id,
        operation_key,
        status: "created",
        mode: createdSub.mode,
      });
    } catch (e: any) {
      failed.push({
        event_id: event.id,
        event_label: event.label,
        trigger_kind: trigger.kind,
        operation_key,
        status: "failed",
        reason: "create_subscription_failed",
        error: e.message,
      });
    }
  }

  return {
    ok: failed.length === 0,
    workflow_id: def.id,
    deploy_version: context.deploy_version,
    deployment_id,
    source: context.source ?? "workflow.deploy",
    subscriptions: {
      desired: desiredEvents.length,
      created,
      cancelled,
      unchanged,
      failed,
    },
  };
}

export async function rollbackWorkflowDeploymentSideEffects(
  receipt: WorkflowDeploymentReceipt,
  deps: DeploymentSubscriptionDeps = activeDeps,
): Promise<WorkflowDeploymentSubscriptionReceipt[]> {
  const rolledBack: WorkflowDeploymentSubscriptionReceipt[] = [];
  for (const created of receipt.subscriptions.created) {
    if (!created.subscription_id) continue;
    const raw = await redis.hget(SUBSCRIPTIONS_KEY, created.subscription_id).catch(() => null);
    if (!raw) continue;
    let subscription: Subscription;
    try {
      subscription = JSON.parse(raw);
    } catch {
      continue;
    }
    if (subscription.status !== "active") continue;
    try {
      subscription.status = "cancelled";
      await redis.hset(SUBSCRIPTIONS_KEY, subscription.id, JSON.stringify(subscription));
      await deps.cancelResources(subscription);
      rolledBack.push({
        event_id: subscription.event_id,
        event_label: subscription.event_label,
        trigger_kind: subscription.trigger.kind,
        previous_subscription_id: subscription.id,
        operation_key: created.operation_key,
        status: "cancelled",
        reason: "rollback_failed_deploy_materialization",
      });
    } catch (e: any) {
      rolledBack.push({
        event_id: subscription.event_id,
        event_label: subscription.event_label,
        trigger_kind: subscription.trigger.kind,
        previous_subscription_id: subscription.id,
        operation_key: created.operation_key,
        status: "failed",
        reason: "rollback_failed_deploy_materialization",
        error: e.message,
      });
    }
  }
  return rolledBack;
}
