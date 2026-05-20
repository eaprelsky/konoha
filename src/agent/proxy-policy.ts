export const AGENT_PROXY_ENV_KEYS = [
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
] as const;

const CODEX_EGRESS_PROXY_ENV_KEYS = ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"] as const;

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value && value.trim() ? value : undefined;
}

export function collectAgentProxyEnv(env: NodeJS.ProcessEnv = process.env): Array<[string, string]> {
  return AGENT_PROXY_ENV_KEYS.flatMap(key => {
    const value = envValue(env, key);
    return value ? [[key, value] as [string, string]] : [];
  });
}

export function agentProxySystemdSetenvArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return collectAgentProxyEnv(env).map(([key, value]) => `--setenv=${key}=${value}`);
}

export function hasCodexEgressProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  return CODEX_EGRESS_PROXY_ENV_KEYS.some(key => Boolean(envValue(env, key)));
}

export function assertCodexEgressProxy(env: NodeJS.ProcessEnv = process.env): void {
  if (!hasCodexEgressProxy(env)) {
    throw new Error(
      "Refusing to start Codex without https_proxy/HTTPS_PROXY/all_proxy/ALL_PROXY; direct egress can be region-blocked",
    );
  }
}
