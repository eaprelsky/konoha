/**
 * action-coverage.ts — API/MCP action coverage matrix generator (#590)
 *
 * Reads the action registry and checks API, MCP, /act, and test coverage
 * for each action. Outputs a markdown table sorted by scope.
 *
 * Usage:
 *   bun run scripts/action-coverage.ts              # print matrix
 *   bun run scripts/action-coverage.ts --gaps-only   # only show uncovered
 */

import { dumpRegistry, type ActionDef } from "../src/action-registry";

// MCP tools defined in src/mcp.ts — tool name to action mapping
const MCP_TOOL_ACTIONS: Record<string, string> = {
  konoha_register: "agent.register",
  konoha_send: "message.send",
  konoha_read: "message.read",
  konoha_agents: "agent.register", // list agents
  konoha_channels: "message.read", // list channels
  konoha_heartbeat: "agent.register", // heartbeat
  konoha_history: "message.read", // read history
  konoha_listen: "message.read", // listen for messages
  konoha_complete_task: "workitem.complete",
};

// MCP tool names (from src/mcp.ts tool registry)
const MCP_TOOLS = new Set([
  "konoha_register", "konoha_send", "konoha_read", "konoha_agents",
  "konoha_channels", "konoha_heartbeat", "konoha_history", "konoha_listen",
  "konoha_complete_task",
]);

interface CoverageEntry {
  action: ActionDef;
  hasApi: boolean;
  hasMcp: boolean;
  hasAct: boolean; // always true — /act routes all registry actions
  hasTest: boolean;
}

const KNOWN_TEST_FILES = [
  "tests/workflow-action-contract.test.ts",
  "tests/act-workflow-executor.test.ts",
  "tests/operator-evals.test.ts",
  "tests/assistant-autonomy-evals.test.ts",
  "tests/ai-chat-contract.test.ts",
  "tests/cases_unit.test.ts",
  "tests/eepc-state-machine-regression.test.ts",
  "tests/applyPatch.test.ts",
  "tests/kwe_gateways.test.ts",
];

function checkTestCoverage(actionId: string): boolean {
  const scope = actionId.split(".")[0];
  // Heuristic: test files cover related scopes
  const scopePatterns: Record<string, string[]> = {
    workflow: ["workflow-action-contract", "act-workflow-executor", "operator-evals", "assistant-autonomy"],
    element: ["workflow-action-contract", "act-workflow-executor"],
    flow: ["workflow-action-contract", "act-workflow-executor"],
    trigger: ["workflow-action-contract"],
    case: ["cases_unit", "eepc-state-machine-regression", "kwe_gateways"],
    workitem: ["cases_unit", "eepc-state-machine-regression"],
    role: ["workflow-action-contract"],
    agent: ["workflow-action-contract"],
    subscription: ["workflow-action-contract"],
    reminder: ["workflow-action-contract"],
    issue: [],
    audit: ["workflow-action-contract"],
    message: ["workflow-action-contract"],
    connector: ["workflow-action-contract"],
    knowledge: ["workflow-action-contract"],
    skill: [],
    person: [],
    adapter: [],
  };
  const patterns = scopePatterns[scope] ?? [];
  return patterns.some(p => KNOWN_TEST_FILES.some(f => f.includes(p)));
}

function main(): void {
  const { actions } = dumpRegistry();
  const entries: CoverageEntry[] = actions.map(action => ({
    action,
    hasApi: !!action.currentEndpoint,
    hasMcp: Object.values(MCP_TOOL_ACTIONS).includes(action.id),
    hasAct: true,
    hasTest: checkTestCoverage(action.id),
  }));

  const gapsOnly = process.argv.includes("--gaps-only");

  // Group by scope
  const scopes = [...new Set(entries.map(e => e.action.scope))].sort();

  console.log("# Action Coverage Matrix\n");
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`Version: ${dumpRegistry().version}`);
  console.log(`Total actions: ${actions.length}`);
  console.log(`API coverage: ${entries.filter(e => e.hasApi).length}/${actions.length}`);
  console.log(`MCP coverage: ${entries.filter(e => e.hasMcp).length}/${actions.length}`);
  console.log(`Test coverage: ${entries.filter(e => e.hasTest).length}/${actions.length}`);
  console.log("");

  // Table header
  console.log("| Action | Scope | API | MCP | /act | Test |");
  console.log("|--------|-------|-----|-----|------|------|");

  const gaps: string[] = [];

  for (const scope of scopes) {
    const scopeEntries = entries.filter(e => e.action.scope === scope);
    for (const entry of scopeEntries) {
      const { action } = entry;
      const api = entry.hasApi ? "`" + (action.currentEndpoint ?? "?") + "`" : "—";
      const mcp = entry.hasMcp ? "✓" : "—";
      const test = entry.hasTest ? "✓" : "—";

      if (gapsOnly && entry.hasApi && entry.hasMcp && entry.hasTest) continue;

      console.log(`| ${action.id} | ${action.scope} | ${api} | ${mcp} | ✓ | ${test} |`);

      if (!entry.hasApi) gaps.push(`${action.id}: no API endpoint`);
      if (!entry.hasMcp) gaps.push(`${action.id}: no MCP tool`);
      if (!entry.hasTest) gaps.push(`${action.id}: no test coverage`);
    }
  }

  if (gaps.length > 0) {
    console.log("\n## Gaps\n");
    for (const gap of gaps) {
      console.log(`- ${gap}`);
    }
  }

  const uncovered = entries.filter(e => !e.hasApi || !e.hasMcp || !e.hasTest).length;
  if (uncovered > 0) {
    console.log(`\n${uncovered} action(s) have at least one coverage gap.`);
  } else {
    console.log("\nAll actions fully covered.");
  }
}

main();
