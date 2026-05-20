import { describe, expect, test } from "bun:test";
import {
  agentSlicePolicy,
  buildAgentSystemdScopeCommand,
  systemdScopesEnabled,
  systemdUnitSegment,
} from "../src/agent/systemd-slices";

describe("agent systemd slice policy", () => {
  test("routes connector-owned agents to connector slice", () => {
    const policy = agentSlicePolicy("naruto", { lifecycle_mode: "connector_owned" });

    expect(policy.slice).toBe("konoha-connectors.slice");
    expect(policy.memoryMax).toBe("1200M");
    expect(policy.cpuQuota).toBe("250%");
  });

  test("routes Kiba to optional worker slice", () => {
    const policy = agentSlicePolicy("kiba", { seed_classification: "optional_worker" });

    expect(policy.slice).toBe("konoha-agents.slice");
    expect(policy.memoryMax).toBe("900M");
  });

  test("routes SDD on-demand workers to QA slice", () => {
    expect(agentSlicePolicy("kakashi", { seed_classification: "optional_worker" }).slice).toBe("konoha-qa.slice");
    expect(agentSlicePolicy("shikadai", { seed_classification: "optional_worker" }).slice).toBe("konoha-qa.slice");
  });

  test("builds a root systemd transient scope around tmux", () => {
    const scoped = buildAgentSystemdScopeCommand("kakashi", { seed_classification: "optional_worker" }, "tmux", [
      "-L",
      "kakashi",
      "new-session",
      "-d",
    ]);

    expect(scoped.cmd).toBe("sudo");
    expect(scoped.unit).toBe("konoha-agent-kakashi");
    expect(scoped.args).toContain("systemd-run");
    expect(scoped.args).toContain("--scope");
    expect(scoped.args).toContain("--collect");
    expect(scoped.args).toContain("--slice=konoha-qa.slice");
    expect(scoped.args).toContain("--uid=ubuntu");
    expect(scoped.args).toContain("--property=MemoryMax=900M");
    expect(scoped.args).toContain("--property=CPUQuota=150%");
    expect(scoped.args.slice(-4)).toEqual(["tmux", "-L", "kakashi", "new-session", "-d"].slice(-4));
  });

  test("propagates proxy environment into systemd scope", () => {
    const scoped = buildAgentSystemdScopeCommand(
      "kakashi",
      { seed_classification: "optional_worker" },
      "tmux",
      ["-L", "kakashi", "new-session", "-d"],
      {
        https_proxy: "http://127.0.0.1:8118",
        http_proxy: "http://127.0.0.1:8118",
        no_proxy: "127.0.0.1,localhost",
        NO_PROXY: "127.0.0.1,localhost",
      } as NodeJS.ProcessEnv,
    );

    expect(scoped.args).toContain("--setenv=https_proxy=http://127.0.0.1:8118");
    expect(scoped.args).toContain("--setenv=http_proxy=http://127.0.0.1:8118");
    expect(scoped.args).toContain("--setenv=no_proxy=127.0.0.1,localhost");
    expect(scoped.args).toContain("--setenv=NO_PROXY=127.0.0.1,localhost");
  });

  test("keeps unit names systemd-safe", () => {
    expect(systemdUnitSegment("team lead/kakashi")).toBe("team-lead-kakashi");
  });

  test("allows explicit rollback to direct tmux launch", () => {
    expect(systemdScopesEnabled({ KONOHA_AGENT_SYSTEMD_SCOPE: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(systemdScopesEnabled({ KONOHA_AGENT_SYSTEMD_SCOPE: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });
});
