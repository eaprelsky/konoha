/**
 * action-registry.ts — Unified action vocabulary and registry (#499)
 *
 * A single, versioned source of truth for every action the system exposes.
 * Used by API, MCP, assistant, and UI layers.
 *
 * Design principles:
 *   - Object-scope naming: `{object}.{verb}` (e.g. `workflow.create`)
 *   - Every action has an explicit argument contract
 *   - Registry is frozen at startup — actions are registered declaratively
 *   - Versioned: bump ACTION_VERSION when the vocabulary changes
 */

import { ACTIONS } from "./action-definitions";
import { classifyAction, getActionSecurity } from "./action-policy";
import type {
  ActionCategory,
  ActionDef as CoreActionDef,
  ActionImplementation,
  ActionSecurityPolicy,
  ActionSurfaceEntry as CoreActionSurfaceEntry,
  ValidationResult,
} from "./action-spine/core-types";
export { classifyAction, getActionSecurity } from "./action-policy";
export type {
  ActionActorPolicy,
  ActionCategory,
  ActionImplementation,
  ActionImplementationKind,
  ActionSecurityPolicy,
  ArgumentDef,
  AutonomyLevel,
  ValidationResult,
} from "./action-spine/core-types";

// ── Version ─────────────────────────────────────────────────────────────────

export const ACTION_VERSION = 24;

// ── Konoha host vocabulary ──────────────────────────────────────────────────

export type KonohaActionScope =
  | "workflow"    // process definitions
  | "element"     // nodes inside a workflow (event, function, gateway)
  | "flow"        // edges between elements
  | "trigger"     // event subscriptions and trigger configuration
  | "case"        // running process instances
  | "workitem"    // dispatched work items
  | "role"        // role definitions and assignments
  | "agent"       // agent lifecycle (register, start, stop, restart)
  | "assistant"   // product assistant invocation and testbench entry points
  | "skill"       // skill CRUD
  | "person"      // people directory
  | "access"      // trusted users and Telegram group access
  | "connector"   // external system connectors such as messengers
  | "adapter"     // data adapter operations
  | "reminder"    // scheduled reminders
  | "issue"       // GitHub issue operations
  | "subscription"// event manager subscriptions
  | "audit"       // audit log reads
  | "knowledge"   // knowledge base operations
  | "retention"   // data lifecycle reports, cleanup previews, and cleanup apply
  | "message";    // bus messages

export type ObjectScope = KonohaActionScope;
export type ActionDef = CoreActionDef<KonohaActionScope>;
export type ActionSurfaceEntry = CoreActionSurfaceEntry<KonohaActionScope>;

// ── Registry API ────────────────────────────────────────────────────────────

const registry = new Map<string, ActionDef>();

// Populate on load
for (const action of ACTIONS) {
  registry.set(action.id, action);
}

/** Freeze the array — callers get readonly references */
export function getAction(id: string): ActionDef | undefined {
  return registry.get(id);
}

export function listActions(scope?: ObjectScope): ActionDef[] {
  const all = [...registry.values()];
  if (!scope) return all;
  return all.filter(a => a.scope === scope);
}

export function getActionsByScope(scope: ObjectScope): ActionDef[] {
  return listActions(scope);
}

export function getScopes(): ObjectScope[] {
  const scopes = new Set<ObjectScope>();
  for (const action of registry.values()) scopes.add(action.scope);
  return [...scopes];
}

/** Validate that an action ID is known to the registry */
export function isValidAction(id: string): boolean {
  return registry.has(id);
}

/** Get the total count of registered actions */
export function getActionCount(): number {
  return registry.size;
}

function resolveImplementation(action: ActionDef): ActionImplementation {
  if (action.implementation) return action.implementation;
  if (action.currentEndpoint) return { kind: "endpoint", note: action.currentEndpoint };
  return { kind: "planned", note: "No endpoint, direct executor, or registered handler has been declared yet." };
}

export function getActionSurface(action: ActionDef): ActionSurfaceEntry {
  const implementation = resolveImplementation(action);
  return {
    ...action,
    category: classifyAction(action.id),
    implementation,
    security: getActionSecurity(action),
    implemented: implementation.kind !== "planned",
  };
}

export function listActionSurface(scope?: ObjectScope): ActionSurfaceEntry[] {
  return listActions(scope).map(getActionSurface);
}

/** Full registry dump for debugging / API exposure */
export function dumpRegistry(): { version: number; actions: ActionDef[]; surface: ActionSurfaceEntry[] } {
  const actions = [...registry.values()];
  return { version: ACTION_VERSION, actions, surface: actions.map(getActionSurface) };
}

// ── Argument Validation ──────────────────────────────────────────────────────

/** Validate that provided args match the ActionDef argument contract */
export function validateActionArgs(actionId: string, args: Record<string, unknown>): ValidationResult {
  const action = registry.get(actionId);
  if (!action) {
    return { valid: false, errors: [`Unknown action: ${actionId}`] };
  }

  const errors: string[] = [];

  for (const arg of action.args) {
    const value = args[arg.name];

    // Check required
    if (arg.required && (value === undefined || value === null)) {
      errors.push(`Missing required argument: ${arg.name}`);
      continue;
    }

    // Skip type check for missing optional args
    if (value === undefined || value === null) continue;

    // Type coercion checks
    switch (arg.type) {
      case "string":
        if (typeof value !== "string") errors.push(`Expected string for "${arg.name}", got ${typeof value}`);
        break;
      case "number":
        if (typeof value !== "number" || Number.isNaN(value)) errors.push(`Expected number for "${arg.name}", got ${typeof value}`);
        break;
      case "boolean":
        if (typeof value !== "boolean") errors.push(`Expected boolean for "${arg.name}", got ${typeof value}`);
        break;
      case "object":
        if (typeof value !== "object" || value === null || Array.isArray(value)) errors.push(`Expected object for "${arg.name}"`);
        break;
      case "array":
        if (!Array.isArray(value)) errors.push(`Expected array for "${arg.name}", got ${typeof value}`);
        break;
      case "date":
        if (typeof value !== "string" || Number.isNaN(Date.parse(value as string))) errors.push(`Expected ISO 8601 date string for "${arg.name}"`);
        break;
    }
  }

  return { valid: errors.length === 0, errors };
}

export interface ActionContract {
  def: ActionDef;
  validate: (args: Record<string, unknown>) => ValidationResult;
}

/** Get a typed action contract for use by the assistant layer */
export function getActionContract(actionId: string): ActionContract | undefined {
  const def = registry.get(actionId);
  if (!def) return undefined;
  return {
    def,
    validate: (args: Record<string, unknown>) => validateActionArgs(actionId, args),
  };
}
