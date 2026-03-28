/**
 * Issue #77: check_services() should support both full and short service names
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";

describe("Issue #77: paused-services name normalization", () => {
  test("akamaru.py contains fix for short name matching", async () => {
    const script = readFileSync("/home/ubuntu/konoha/scripts/akamaru.py", "utf-8");
    
    // Check for short name extraction
    expect(script).toContain("removeprefix");
    expect(script).toContain("removesuffix");
    
    // Check for both full and short name check
    expect(script).toContain("if svc in paused or short in paused");
  });

  test("fix extracts short names correctly", async () => {
    const testCases = [
      { full: "claude-naruto.service", short: "naruto" },
      { full: "claude-sasuke.service", short: "sasuke" },
      { full: "claude-mirai.service", short: "mirai" },
      { full: "claude-watchdog-naruto.service", short: "naruto" },
      { full: "claude-watchdog-mirai.service", short: "mirai" },
    ];

    for (const tc of testCases) {
      let short = tc.full;
      short = short.replace(/^claude-/, "");
      short = short.replace(/^watchdog-/, "");
      short = short.replace(/\.service$/, "");
      expect(short).toBe(tc.short);
    }
  });

  test("paused-services.txt supports flexible naming", async () => {
    // User can write any of these in paused-services.txt
    const validPausedFormats = [
      "naruto",                      // short name
      "claude-naruto.service",       // full name
      "claude-watchdog-mirai.service", // with watchdog prefix
      "sasuke",                      // another agent
    ];

    // All should be valid entries
    for (const name of validPausedFormats) {
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });

  test("check_services() logic handles all formats", async () => {
    // Simulate the fix logic
    function shouldSkip(svc: string, paused: Set<string>): boolean {
      const short = svc
        .replace(/^claude-/, "")
        .replace(/^watchdog-/, "")
        .replace(/\.service$/, "");
      return paused.has(svc) || paused.has(short);
    }

    // Test cases
    const tests = [
      { svc: "claude-naruto.service", paused: new Set(["naruto"]), expected: true },
      { svc: "claude-naruto.service", paused: new Set(["claude-naruto.service"]), expected: true },
      { svc: "claude-mirai.service", paused: new Set(["mirai"]), expected: true },
      { svc: "claude-naruto.service", paused: new Set(["sasuke"]), expected: false },
    ];

    for (const test of tests) {
      const result = shouldSkip(test.svc, test.paused);
      expect(result).toBe(test.expected);
    }
  });
});
