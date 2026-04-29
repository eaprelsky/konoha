import { ConfigError } from "./errors";

export type LlmProvider = "anthropic" | "glm";

function readString(name: string, fallback?: string): string {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : (fallback ?? "");
}

function normalizeProvider(value: string): LlmProvider {
  return value === "glm" ? "glm" : "anthropic";
}

export const config = {
  auth: {
    adminToken: readString("KONOHA_TOKEN", "konoha-dev-token"),
  },
  dashboard: {
    user: readString("KONOHA_DASHBOARD_USER", "admin"),
    hosts: readString("KONOHA_DASHBOARD_HOSTS")
      .split(",")
      .map(host => host.trim().toLowerCase())
      .filter(Boolean),
  },
  llm: {
    provider: normalizeProvider(readString("KONOHA_LLM_PROVIDER", readString("LLM_PROVIDER", "anthropic"))),
    anthropicApiKey: readString("ANTHROPIC_API_KEY"),
    glmApiKey: readString("GLM_API_KEY"),
    glmBaseUrl: readString("GLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4").replace(/\/$/, ""),
  },
  logging: {
    level: readString("LOG_LEVEL", "info"),
  },
  paths: {
    trustedUsers: "/opt/shared/.trusted-users.json",
    workspaceDir: "/opt/shared/workspace",
    setupFile: readString("KONOHA_SETUP_FILE", "/opt/shared/.konoha-setup.json"),
  },
  storage: {
    databaseUrl: readString("DATABASE_URL", "postgres://127.0.0.1:5432/konoha"),
    pgRead: readString("PG_READ") === "true",
    redisDb: Number(readString("REDIS_DB", "0")),
  },
};

export function requireConfig(name: string, value: string | undefined): string {
  if (!value) throw new ConfigError(`Missing required config: ${name}`, { name });
  return value;
}
