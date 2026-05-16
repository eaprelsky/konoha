/**
 * Prompt authority and AGENTS.md mirror drift checks.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { buildSystemPrompt } from "./prompt";
import { AGENT_WORKDIR_ROOT } from "./runtime";
import { getAgentDef, sha256Text } from "./crud";
import type { AgentDef } from "./types";

export type PromptMirrorStatus = "ok" | "missing" | "drift" | "agent_missing";

export interface PromptMirrorDriftResult {
  status: PromptMirrorStatus;
  source: "AgentDef.system_prompt";
  mirror_path?: string;
  expected_hash?: string;
  mirror_hash?: string;
  stored_rendered_prompt_hash?: string;
  system_prompt_hash?: string;
}

export async function checkAgentPromptMirrorDrift(agentId: string, def?: AgentDef): Promise<PromptMirrorDriftResult> {
  const agentDef = def ?? await getAgentDef(agentId);
  if (!agentDef) return { status: "agent_missing", source: "AgentDef.system_prompt" };

  const mirrorPath = agentDef.rendered_prompt_path ?? join(AGENT_WORKDIR_ROOT, agentId, "AGENTS.md");
  const expected = await buildSystemPrompt(agentId, agentDef);
  const expectedHash = sha256Text(expected);

  if (!existsSync(mirrorPath)) {
    return {
      status: "missing",
      source: "AgentDef.system_prompt",
      mirror_path: mirrorPath,
      expected_hash: expectedHash,
      stored_rendered_prompt_hash: agentDef.rendered_prompt_hash,
      system_prompt_hash: sha256Text(agentDef.system_prompt ?? ""),
    };
  }

  const mirror = readFileSync(mirrorPath, "utf-8");
  const mirrorHash = sha256Text(mirror);
  return {
    status: mirrorHash === expectedHash ? "ok" : "drift",
    source: "AgentDef.system_prompt",
    mirror_path: mirrorPath,
    expected_hash: expectedHash,
    mirror_hash: mirrorHash,
    stored_rendered_prompt_hash: agentDef.rendered_prompt_hash,
    system_prompt_hash: sha256Text(agentDef.system_prompt ?? ""),
  };
}
