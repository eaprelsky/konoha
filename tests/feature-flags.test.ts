import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveFeatureFlags, featureForMcpPack } from "../src/feature-flags";

const missingOverride = join(mkdtempSync(join(tmpdir(), "konoha-feature-flags-")), "missing.json");

function enabledIds(profile: string, extraEnv: Record<string, string> = {}): string[] {
  return resolveFeatureFlags({
    KONOHA_SERVICE_PROFILE: profile,
    KONOHA_FEATURE_FLAGS_FILE: missingOverride,
    ...extraEnv,
  }).features.filter(feature => feature.enabled).map(feature => feature.id).sort();
}

describe("feature flags", () => {
  test("keeps experimental product surfaces default-off in core profiles", () => {
    expect(enabledIds("prod-core")).toEqual([]);
    expect(enabledIds("staging-core")).toEqual([]);
  });

  test("enables only bounded QA testbench in qa-on-demand", () => {
    expect(enabledIds("qa-on-demand")).toEqual(["testbench"]);
  });

  test("records who enabled an env feature override and why", () => {
    const response = resolveFeatureFlags({
      KONOHA_SERVICE_PROFILE: "prod-core",
      KONOHA_FEATURE_FLAGS_FILE: missingOverride,
      KONOHA_ENABLED_FEATURES: "corporate-memory",
      KONOHA_FEATURE_ENABLE_REASON: "time-boxed acceptance check",
      USER: "operator",
    });
    const feature = response.features.find(item => item.id === "corporate-memory");

    expect(feature?.enabled).toBe(true);
    expect(feature?.enabled_by).toBe("env:operator");
    expect(feature?.reason).toBe("time-boxed acceptance check");
  });

  test("maps experimental MCP packs to feature gates", () => {
    expect(featureForMcpPack("yonote")).toBe("corporate-memory");
    expect(featureForMcpPack("excel")).toBe("office-miro-mcp");
    expect(featureForMcpPack("puppeteer")).toBe("direct-browser-mcp");
    expect(featureForMcpPack("konoha")).toBeUndefined();
  });
});
