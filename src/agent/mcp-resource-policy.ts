export interface McpResourcePolicy {
  slice: string;
  memoryHigh: string;
  memoryMax: string;
  cpuWeight: number;
  cpuQuota: string;
  tasksMax: number;
}

const DEFAULT_ON_DEMAND_MCP_POLICY: McpResourcePolicy = {
  slice: "konoha-qa.slice",
  memoryHigh: "256M",
  memoryMax: "384M",
  cpuWeight: 80,
  cpuQuota: "50%",
  tasksMax: 512,
};

const LOW_COST_ON_DEMAND_MCP_POLICY: McpResourcePolicy = {
  slice: "konoha-qa.slice",
  memoryHigh: "128M",
  memoryMax: "256M",
  cpuWeight: 60,
  cpuQuota: "25%",
  tasksMax: 256,
};

const ON_DEMAND_MCP_RESOURCE_POLICIES: ReadonlyMap<string, McpResourcePolicy> = new Map([
  ["excel", DEFAULT_ON_DEMAND_MCP_POLICY],
  ["filesystem", LOW_COST_ON_DEMAND_MCP_POLICY],
  ["gitlab", DEFAULT_ON_DEMAND_MCP_POLICY],
  ["google-docs", DEFAULT_ON_DEMAND_MCP_POLICY],
  ["google-sheets", DEFAULT_ON_DEMAND_MCP_POLICY],
  ["memory", DEFAULT_ON_DEMAND_MCP_POLICY],
  ["puppeteer", DEFAULT_ON_DEMAND_MCP_POLICY],
  ["sequential-thinking", DEFAULT_ON_DEMAND_MCP_POLICY],
  ["word", DEFAULT_ON_DEMAND_MCP_POLICY],
  ["yonote", LOW_COST_ON_DEMAND_MCP_POLICY],
  ["yonote-read", LOW_COST_ON_DEMAND_MCP_POLICY],
]);

export function mcpResourcePolicy(server: string): McpResourcePolicy | undefined {
  return ON_DEMAND_MCP_RESOURCE_POLICIES.get(server);
}
