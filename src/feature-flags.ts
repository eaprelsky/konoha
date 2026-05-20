import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { MiddlewareHandler } from "hono";

const FEATURE_FLAGS_PATH = resolve(import.meta.dir, "..", "docs", "feature-flags.json");
const SERVICE_PROFILES_PATH = resolve(import.meta.dir, "..", "docs", "service-profiles.json");

export type FeatureFlagId =
  | "corporate-memory"
  | "broad-admin-assistant"
  | "optional-dashboards"
  | "office-miro-mcp"
  | "direct-browser-mcp"
  | "testbench";

export type FeatureSurface = {
  routes: string[];
  ui: string[];
  agents: string[];
  mcp_packs: string[];
};

export type FeatureFlagDefinition = {
  id: FeatureFlagId;
  description: string;
  default_enabled: boolean;
  surfaces: FeatureSurface;
};

export type FeatureFlagState = FeatureFlagDefinition & {
  enabled: boolean;
  enabled_by?: string;
  reason?: string;
};

export type FeatureFlagsResponse = {
  profile: string;
  source: string;
  features: FeatureFlagState[];
};

type FeatureCatalog = {
  schema_version: number;
  default_profile: string;
  flags: Record<string, Omit<FeatureFlagDefinition, "id">>;
  profiles: Record<string, { enabled_features?: string[] }>;
};

type ServiceProfileCatalog = {
  default_profile?: string;
  profiles?: Record<string, { enabled_features?: string[] }>;
};

type FeatureOverride = {
  enabled?: boolean;
  enabled_by?: string;
  reason?: string;
};

type FeatureOverrideFile = {
  enabled_features?: string[];
  features?: Record<string, FeatureOverride>;
};

const MCP_PACK_FEATURES: Record<string, FeatureFlagId> = {
  yonote: "corporate-memory",
  "yonote-read": "corporate-memory",
  memory: "corporate-memory",
  excel: "office-miro-mcp",
  word: "office-miro-mcp",
  "google-docs": "office-miro-mcp",
  "google-sheets": "office-miro-mcp",
  miro: "office-miro-mcp",
  "miro-api": "office-miro-mcp",
  puppeteer: "direct-browser-mcp",
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map(item => item.trim()).filter(Boolean);
}

function loadCatalog(path = FEATURE_FLAGS_PATH): FeatureCatalog {
  const catalog = readJson<FeatureCatalog>(path);
  if (catalog.schema_version !== 1) {
    throw new Error(`Unsupported feature flag schema_version=${catalog.schema_version}`);
  }
  return catalog;
}

function serviceProfileFromEnv(env: NodeJS.ProcessEnv): string {
  const explicit = env.KONOHA_FEATURE_PROFILE || env.KONOHA_SERVICE_PROFILE;
  if (explicit?.trim()) return explicit.trim();
  if (existsSync(SERVICE_PROFILES_PATH)) {
    const serviceProfiles = readJson<ServiceProfileCatalog>(SERVICE_PROFILES_PATH);
    if (serviceProfiles.default_profile) return serviceProfiles.default_profile;
  }
  return "prod-core";
}

function enabledFeaturesForProfile(profile: string, catalog: FeatureCatalog): Set<string> {
  if (existsSync(SERVICE_PROFILES_PATH)) {
    const serviceProfiles = readJson<ServiceProfileCatalog>(SERVICE_PROFILES_PATH);
    const serviceProfileFeatures = serviceProfiles.profiles?.[profile]?.enabled_features;
    if (Array.isArray(serviceProfileFeatures)) return new Set(serviceProfileFeatures.map(String));
  }
  return new Set((catalog.profiles[profile]?.enabled_features ?? []).map(String));
}

function applyOverrideFile(states: Map<string, FeatureFlagState>, path: string): void {
  if (!existsSync(path)) return;
  const raw = readJson<FeatureOverrideFile>(path);
  for (const id of raw.enabled_features ?? []) {
    const state = states.get(String(id));
    if (!state) continue;
    state.enabled = true;
    state.enabled_by = `file:${path}`;
    state.reason = "enabled_features override";
  }
  for (const [id, override] of Object.entries(raw.features ?? {})) {
    const state = states.get(id);
    if (!state) continue;
    state.enabled = override.enabled === true;
    state.enabled_by = override.enabled_by || `file:${path}`;
    state.reason = override.reason || "feature override file";
  }
}

export function resolveFeatureFlags(env: NodeJS.ProcessEnv = process.env): FeatureFlagsResponse {
  const catalog = loadCatalog();
  const profile = serviceProfileFromEnv(env);
  const profileEnabled = enabledFeaturesForProfile(profile, catalog);
  const states = new Map<string, FeatureFlagState>();

  for (const [id, definition] of Object.entries(catalog.flags)) {
    const enabled = definition.default_enabled || profileEnabled.has(id);
    states.set(id, {
      id: id as FeatureFlagId,
      ...definition,
      enabled,
      ...(enabled ? {
        enabled_by: profileEnabled.has(id) ? `service-profile:${profile}` : "catalog-default",
        reason: profileEnabled.has(id) ? "enabled by selected service profile" : "enabled by catalog default",
      } : {}),
    });
  }

  applyOverrideFile(states, env.KONOHA_FEATURE_FLAGS_FILE || "/opt/shared/konoha-feature-flags.json");

  const envEnabled = parseCsv(env.KONOHA_ENABLED_FEATURES);
  for (const id of envEnabled) {
    const state = states.get(id);
    if (!state) continue;
    state.enabled = true;
    state.enabled_by = env.USER ? `env:${env.USER}` : "env:KONOHA_ENABLED_FEATURES";
    state.reason = env.KONOHA_FEATURE_ENABLE_REASON || "enabled via KONOHA_ENABLED_FEATURES";
  }

  const envDisabled = parseCsv(env.KONOHA_DISABLED_FEATURES);
  for (const id of envDisabled) {
    const state = states.get(id);
    if (!state) continue;
    state.enabled = false;
    state.enabled_by = undefined;
    state.reason = undefined;
  }

  return {
    profile,
    source: FEATURE_FLAGS_PATH,
    features: [...states.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function isFeatureEnabled(id: FeatureFlagId, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveFeatureFlags(env).features.some(feature => feature.id === id && feature.enabled);
}

export function featureForMcpPack(packName: string): FeatureFlagId | undefined {
  return MCP_PACK_FEATURES[packName];
}

export function requireFeature(id: FeatureFlagId): MiddlewareHandler {
  return async (c, next) => {
    const feature = resolveFeatureFlags().features.find(item => item.id === id);
    if (!feature?.enabled) {
      return c.json({
        error: "Feature disabled",
        feature: id,
        reason: feature?.description || "This experimental surface is disabled by the selected Konoha profile.",
      }, 404);
    }
    await next();
  };
}
