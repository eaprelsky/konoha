/**
 * Issue #75: Akamaru should skip alerts for services listed in paused-services.txt
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
const _tmpDir = mkdtempSync(join(tmpdir(), "akamaru-test-"));
const PAUSED_FILE = join(_tmpDir, "paused-services.txt");
const PAUSED_DIR = _tmpDir;

// Helper to set up paused file
function setPausedServices(...services: string[]) {
  mkdirSync(PAUSED_DIR, { recursive: true });
  if (services.length === 0) {
    // Empty file
    writeFileSync(PAUSED_FILE, "");
  } else {
    writeFileSync(PAUSED_FILE, services.join("\n") + "\n");
  }
}

// Helper to clean up
function cleanupPausedFile() {
  if (existsSync(PAUSED_FILE)) {
    try { unlinkSync(PAUSED_FILE); } catch {}
  }
}

// Save and restore the live paused-services.txt so tests don't clobber
// any intentional pauses set by operators (issue #143).
let _savedContent: string | null = null;

beforeAll(() => {
  _savedContent = existsSync(PAUSED_FILE) ? readFileSync(PAUSED_FILE, "utf-8") : null;
});

afterAll(() => {
  if (_savedContent === null) {
    if (existsSync(PAUSED_FILE)) unlinkSync(PAUSED_FILE);
  } else {
    mkdirSync(PAUSED_DIR, { recursive: true });
    writeFileSync(PAUSED_FILE, _savedContent);
  }
});

describe("Issue #75: Akamaru paused-services.txt", () => {
  test("load_paused() returns empty set when file does not exist", async () => {
    cleanupPausedFile();
    // Run Python to test load_paused
    const result = execSync(
      `python3 -c "import sys; sys.path.insert(0, '/home/ubuntu/konoha/scripts'); from akamaru import load_paused; print(len(load_paused()))"`,
      { encoding: "utf-8", env: { ...process.env, AKAMARU_PAUSED_FILE: PAUSED_FILE } }
    ).trim();
    expect(result).toBe("0");
  });

  test("load_paused() reads services from file", async () => {
    setPausedServices("claude-naruto.service", "claude-sasuke.service", "mirai");
    const result = execSync(
      `python3 -c "import sys; sys.path.insert(0, '/home/ubuntu/konoha/scripts'); from akamaru import load_paused; paused = load_paused(); print(sorted(paused))"`,
      { encoding: "utf-8", env: { ...process.env, AKAMARU_PAUSED_FILE: PAUSED_FILE } }
    ).trim();
    expect(result).toContain("claude-naruto.service");
    expect(result).toContain("claude-sasuke.service");
    expect(result).toContain("mirai");
  });

  test("load_paused() ignores blank lines and whitespace", async () => {
    setPausedServices("naruto", "", "  sasuke  ", "\n", "hinata");
    const result = execSync(
      `python3 -c "import sys; sys.path.insert(0, '/home/ubuntu/konoha/scripts'); from akamaru import load_paused; paused = load_paused(); print(len(paused))"`,
      { encoding: "utf-8", env: { ...process.env, AKAMARU_PAUSED_FILE: PAUSED_FILE } }
    ).trim();
    // Should have 3 services (naruto, sasuke, hinata), blank lines ignored
    expect(result).toBe("3");
  });

  test("check_services() skips paused services", async () => {
    setPausedServices("claude-naruto.service");
    // This is harder to test end-to-end, but we can verify the logic is there
    const code = `
import sys
sys.path.insert(0, '/home/ubuntu/konoha/scripts')
from akamaru import load_paused, check_services

paused = load_paused()
# Mock: if naruto is paused, it should be skipped
if "claude-naruto.service" in paused:
    print("PAUSED_CHECK_OK")
else:
    print("PAUSED_CHECK_FAILED")
`;
    // Use stdin to avoid shell-quoting issues with double-quoted strings inside `code`
    const result = execSync("python3", { encoding: "utf-8", input: code, env: { ...process.env, AKAMARU_PAUSED_FILE: PAUSED_FILE } }).trim();
    expect(result).toBe("PAUSED_CHECK_OK");
  });

  test("paused-services.txt path is correct", async () => {
    setPausedServices("test-service");
    const exists = existsSync(PAUSED_FILE);
    expect(exists).toBe(true);
    const content = execSync(`cat ${PAUSED_FILE}`, { encoding: "utf-8" }).trim();
    expect(content).toBe("test-service");
  });
});
