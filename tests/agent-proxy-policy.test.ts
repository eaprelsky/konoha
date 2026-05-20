import { describe, expect, test } from "bun:test";
import {
  agentProxySystemdSetenvArgs,
  assertCodexEgressProxy,
  hasCodexEgressProxy,
} from "../src/agent/proxy-policy";

describe("agent proxy policy", () => {
  test("fails closed for Codex when no egress proxy is configured", () => {
    expect(hasCodexEgressProxy({} as NodeJS.ProcessEnv)).toBe(false);
    expect(() => assertCodexEgressProxy({} as NodeJS.ProcessEnv)).toThrow("Refusing to start Codex");
  });

  test("allows Codex when an HTTPS proxy is configured", () => {
    const env = { https_proxy: "http://127.0.0.1:8118" } as NodeJS.ProcessEnv;

    expect(hasCodexEgressProxy(env)).toBe(true);
    expect(() => assertCodexEgressProxy(env)).not.toThrow();
  });

  test("builds systemd setenv args only for configured proxy keys", () => {
    const args = agentProxySystemdSetenvArgs({
      https_proxy: "http://127.0.0.1:8118",
      no_proxy: "127.0.0.1,localhost",
      EMPTY: "",
    } as NodeJS.ProcessEnv);

    expect(args).toEqual([
      "--setenv=https_proxy=http://127.0.0.1:8118",
      "--setenv=no_proxy=127.0.0.1,localhost",
    ]);
  });
});
