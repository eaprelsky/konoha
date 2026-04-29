import type { SandboxProfile } from "./types";

const PROFILES: Record<string, SandboxProfile> = {
  tmux: {
    id: "tmux",
    type: "tmux",
    config: { socket: "{agent_id}", session: "{agent_id}" },
  },
  process: {
    id: "process",
    type: "process",
    config: { supervisor: "systemd" },
  },
  docker: {
    id: "docker",
    type: "docker",
    config: { status: "planned" },
  },
  remote: {
    id: "remote",
    type: "remote",
    config: { status: "planned" },
  },
};

export function listSandboxProfiles(): SandboxProfile[] {
  return Object.values(PROFILES).sort((a, b) => a.id.localeCompare(b.id));
}

export function getSandboxProfile(id: string | undefined): SandboxProfile | undefined {
  return id ? PROFILES[id] : undefined;
}
