import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

function readJson(path: string): any {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf-8"));
}

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

describe("lean runtime diet closure report", () => {
  test("consolidates the accepted #759 child issue set", () => {
    const report = readJson("docs/lean-runtime-diet-report.json");
    const childIssues = new Set(report.child_issues.map((item: any) => item.issue));

    expect(report.updated_for_issue).toBe(759);
    expect(report.status).toBe("ready_for_epic_review");
    expect([...childIssues].sort((a, b) => a - b)).toEqual([
      754,
      758,
      764,
      765,
      766,
      767,
      769,
      770,
      772,
      773,
      775,
      779,
      782,
      783,
      791,
    ]);

    for (const child of report.child_issues) {
      expect(child.state).toBe("closed");
      expect(child.label).toBe("state:done");
      expect(child.workstream).toBeTruthy();
    }
  });

  test("keeps production Sasuke, Naruto, and mail non-negotiables explicit", () => {
    const report = readJson("docs/lean-runtime-diet-report.json");
    const serviceProfiles = readJson("docs/service-profiles.json");
    const resourceBudgets = readJson("docs/resource-budgets.json");

    expect(report.non_negotiable_guards.sasuke_user_account_ingestion.required_services).toContain("agent-sasuke.service");
    expect(report.non_negotiable_guards.sasuke_user_account_ingestion.required_mcp).toEqual(["konoha", "telethon-channel", "bitrix24"]);
    expect(report.non_negotiable_guards.naruto_orchestration.status).toBe("protected_until_separate_experiment");
    expect(report.non_negotiable_guards.mail_stack.status).toBe("reserved_not_removed");

    expect(serviceProfiles.profiles["prod-core"].required_services).toContain("agent-sasuke.service");
    expect(serviceProfiles.profiles["prod-core"].required_services).toContain("agent-naruto.service");
    expect(resourceBudgets.host_capacity.reservations.find((item: any) => item.id === "shared_mail_stack").removal_policy)
      .toBe("do_not_remove_in_lean_konoha_cleanup");
  });

  test("ties bounded defaults to service, resource, Kiba, and SDD pool contracts", () => {
    const report = readJson("docs/lean-runtime-diet-report.json");
    const serviceProfiles = readJson("docs/service-profiles.json");
    const budgets = readJson("docs/resource-budgets.json");
    const sddPool = readJson("docs/sdd-worker-pool.json");
    const kiba = readJson("docs/kiba-monitor-profile.json");

    expect(report.bounded_defaults.service_profile).toBe(serviceProfiles.default_profile);
    expect(report.bounded_defaults.autostart_agents).toEqual(serviceProfiles.profiles["prod-core"].autostart_agents);
    expect(report.bounded_defaults.disabled_lifecycle_agents).toEqual(serviceProfiles.profiles["prod-core"].disabled_lifecycle_agents);
    expect(report.bounded_defaults.testbench.prod_core_default).toBe(budgets.budget_profiles["prod-core"].testbench.default);
    expect(report.bounded_defaults.testbench.systemd_memory_max).toBe(budgets.systemd.units["konoha-testbench.service"].memory_max);
    expect(report.bounded_defaults.sdd_worker_pool.max_active_workers).toBe(sddPool.max_active_workers);
    expect(report.bounded_defaults.sdd_worker_pool.max_active_specialists).toBe(sddPool.max_active_specialists);
    expect(report.bounded_defaults.kiba.mode).toBe(kiba.mode);
    expect(report.bounded_defaults.kiba.mcp_allowlist).toEqual(kiba.mcp_allowlist);
  });

  test("contains measurable savings evidence with rollback and review commands", () => {
    const report = readJson("docs/lean-runtime-diet-report.json");
    const evidence = new Map(report.source_level_evidence.map((item: any) => [item.id, item]));

    expect(evidence.get("kiba_broad_mcp_to_monitor_core").estimated_savings.rss_kib).toBe(1346324);
    expect(evidence.get("duplicate_telethon_bitrix_removed").estimated_savings.processes).toBe(2);
    expect(evidence.get("testbench_browser_default_off").estimated_savings.rss_kib).toBeGreaterThan(500000);
    expect(evidence.get("optional_host_services").estimated_savings.rss_kib).toBeGreaterThan(100000);

    for (const item of report.source_level_evidence) {
      expect(item.source).toBeTruthy();
      expect(item.additivity).toBeTruthy();
      expect(item.estimated_savings.rss_kib).toBeGreaterThan(0);
    }

    expect(report.rollback_plan.map((item: any) => item.scope)).toContain("Naruto/Sasuke guardrail");
    expect(report.review_commands).toContain("KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py --policy-dry-run");
    expect(report.review_commands).toContain("python3 scripts/resource-inventory.py --json --no-disk");
  });

  test("documents closure decision and remaining gaps without removing safeguards", () => {
    const report = readJson("docs/lean-runtime-diet-report.json");
    const markdown = read("docs/lean-runtime-diet-report.md");

    expect(report.closure_decision.epic_can_close_after_review).toBe(true);
    expect(report.remaining_ops_gaps.map((item: any) => item.id)).toEqual([
      "live_prod_core_inventory_after_restart",
      "mail_externalization",
      "naruto_pause_or_consolidation",
    ]);
    expect(markdown).toContain("The machine-readable closure report is `docs/lean-runtime-diet-report.json`");
    expect(markdown).toContain("Sasuke user-account ingestion remains protected");
    expect(markdown).toContain("Mail stack is reserved");
    expect(markdown).toContain("operational validation, not new architecture blockers");
  });
});
