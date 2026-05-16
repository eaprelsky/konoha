import { existsSync } from "fs";
import type { AgentDef } from "./types";

export type AgentSliceClass = "connector_owned" | "optional_worker" | "qa_on_demand";

export interface AgentSlicePolicy {
  class: AgentSliceClass;
  slice: string;
  memoryHigh: string;
  memoryMax: string;
  cpuWeight: number;
  cpuQuota: string;
  tasksMax: number;
}

export const SYSTEMD_AGENT_PATH =
  "/home/ubuntu/.bun/bin:/home/ubuntu/.npm-global/bin:/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/bin:/bin";

const CONNECTOR_AGENT_IDS = new Set(["naruto", "sasuke", "mirai"]);
const OPTIONAL_WORKER_AGENT_IDS = new Set(["kiba"]);
const QA_ON_DEMAND_AGENT_IDS = new Set([
  "kakashi",
  "shikadai",
  "shino",
  "hinata",
  "guy",
  "ibiki",
  "jiraiya",
  "ino",
  "inojin",
]);

const SLICE_POLICIES: Record<AgentSliceClass, AgentSlicePolicy> = {
  connector_owned: {
    class: "connector_owned",
    slice: "konoha-connectors.slice",
    memoryHigh: "900M",
    memoryMax: "1200M",
    cpuWeight: 250,
    cpuQuota: "250%",
    tasksMax: 4096,
  },
  optional_worker: {
    class: "optional_worker",
    slice: "konoha-agents.slice",
    memoryHigh: "700M",
    memoryMax: "900M",
    cpuWeight: 120,
    cpuQuota: "150%",
    tasksMax: 3072,
  },
  qa_on_demand: {
    class: "qa_on_demand",
    slice: "konoha-qa.slice",
    memoryHigh: "700M",
    memoryMax: "900M",
    cpuWeight: 100,
    cpuQuota: "150%",
    tasksMax: 3072,
  },
};

export function agentSliceClass(id: string, def: Pick<AgentDef, "seed_classification" | "lifecycle_mode">): AgentSliceClass {
  if (def.lifecycle_mode === "connector_owned" || def.seed_classification === "connector_owned" || CONNECTOR_AGENT_IDS.has(id)) {
    return "connector_owned";
  }
  if (OPTIONAL_WORKER_AGENT_IDS.has(id)) return "optional_worker";
  if (QA_ON_DEMAND_AGENT_IDS.has(id)) return "qa_on_demand";
  return "qa_on_demand";
}

export function agentSlicePolicy(id: string, def: Pick<AgentDef, "seed_classification" | "lifecycle_mode">): AgentSlicePolicy {
  return SLICE_POLICIES[agentSliceClass(id, def)];
}

export function systemdScopesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.KONOHA_AGENT_SYSTEMD_SCOPE ?? "").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(value)) return false;
  if (["1", "true", "on", "yes"].includes(value)) return true;
  return process.platform === "linux" && existsSync("/run/systemd/system");
}

export function systemdUnitSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return segment || "agent";
}

export function buildAgentSystemdScopeCommand(
  id: string,
  def: Pick<AgentDef, "seed_classification" | "lifecycle_mode">,
  command: string,
  args: string[],
): { cmd: string; args: string[]; policy: AgentSlicePolicy; unit: string } {
  const policy = agentSlicePolicy(id, def);
  const unit = `konoha-agent-${systemdUnitSegment(id)}`;
  return {
    cmd: "sudo",
    args: [
      "-n",
      "systemd-run",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=${unit}`,
      `--slice=${policy.slice}`,
      "--uid=ubuntu",
      "--gid=ubuntu",
      "--setenv=HOME=/home/ubuntu",
      `--setenv=PATH=${SYSTEMD_AGENT_PATH}`,
      `--property=MemoryHigh=${policy.memoryHigh}`,
      `--property=MemoryMax=${policy.memoryMax}`,
      `--property=CPUWeight=${policy.cpuWeight}`,
      `--property=CPUQuota=${policy.cpuQuota}`,
      `--property=TasksMax=${policy.tasksMax}`,
      "--",
      command,
      ...args,
    ],
    policy,
    unit,
  };
}
