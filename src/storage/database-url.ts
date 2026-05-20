import { config } from "../config";
import { existsSync, readFileSync } from "fs";
import { resolveTestDatabaseUrl } from "./test-isolation";

export const credentialConfig = {
  sources: [
    "/opt/shared/.shared-credentials",
    "/opt/konoha/.env.global",
    "/home/ubuntu/konoha/.env",
  ] as string[],
};

function parseEnvFile(filepath: string): Record<string, string> {
  if (!existsSync(filepath)) return {};
  try {
    return readFileSync(filepath, "utf-8")
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#") && line.includes("="))
      .reduce<Record<string, string>>((acc, line) => {
        const idx = line.indexOf("=");
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
        if (key) acc[key] = value;
        return acc;
      }, {});
  } catch {
    return {};
  }
}

function resolveCredentialEnv(): Record<string, string> {
  for (const source of credentialConfig.sources) {
    const values = parseEnvFile(source);
    if (values.DATABASE_URL || values.PGHOST || values.PGUSER || values.PGPASSWORD) {
      return values;
    }
  }
  return {};
}

function buildDatabaseUrlFromParts(env: Record<string, string>): string | null {
  const host = env.PGHOST;
  const database = env.PGDATABASE;
  if (!host || !database) return null;

  const port = env.PGPORT || "5432";
  const user = env.PGUSER;
  const password = env.PGPASSWORD;
  const auth = user ? `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ""}@` : "";
  return `postgres://${auth}${host}:${port}/${database}`;
}

export function getDatabaseUrl(): string {
  const safeEnv = resolveCredentialEnv();
  const databaseUrl = process.env.DATABASE_URL || safeEnv.DATABASE_URL || buildDatabaseUrlFromParts({ ...safeEnv, ...process.env as Record<string, string> }) || config.storage.databaseUrl;
  return resolveTestDatabaseUrl(databaseUrl);
}

export function hasDatabaseCredentials(): boolean {
  const safeEnv = resolveCredentialEnv();
  return Boolean(
    process.env.DATABASE_URL ||
    safeEnv.DATABASE_URL ||
    ((process.env.PGHOST || safeEnv.PGHOST) && (process.env.PGDATABASE || safeEnv.PGDATABASE)),
  );
}
