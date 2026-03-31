/**
 * Issue #75: Akamaru should skip alerts for services listed in paused-services.txt
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";

const PAUSED_FILE = "/opt/shared/kiba/paused-services.txt";
const PAUSED_DIR = "/opt/shared/kiba";

function setPausedServices(...services: string[]) {
  mkdirSync(PAUSED_DIR, { recursive: true });
  if (services.length === 0) {
    writeFileSync(PAUSED_FILE, "");
  } else {
    writeFileSync(PAUSED_FILE, services.join("\n") + "\n");
  }
}

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

describe("Issue #75: Akamaru paused-services logic", () => {
  test("paused-services.txt file can be created and read", async () => {
    setPausedServices("claude-naruto.service", "hinata");
    const exists = existsSync(PAUSED_FILE);
    expect(exists).toBe(true);
    
    const content = readFileSync(PAUSED_FILE, "utf-8");
    expect(content).toContain("claude-naruto.service");
    expect(content).toContain("hinata");
  });

  test("paused-services.txt empty file is valid", async () => {
    setPausedServices();
    const exists = existsSync(PAUSED_FILE);
    expect(exists).toBe(true);
    
    const content = readFileSync(PAUSED_FILE, "utf-8");
    expect(content).toBe("");
  });

  test("paused-services.txt with blank lines", async () => {
    // Write file with blank lines (simulating real-world usage)
    mkdirSync(PAUSED_DIR, { recursive: true });
    writeFileSync(PAUSED_FILE, "naruto\n\nsasuke\n  \nhinata\n");
    
    const content = readFileSync(PAUSED_FILE, "utf-8");
    const lines = content.split("\n").filter(line => line.trim());
    
    expect(lines.length).toBe(3);
    expect(lines).toContain("naruto");
    expect(lines).toContain("sasuke");
    expect(lines).toContain("hinata");
  });

  test("akamaru.py defines PAUSED_FILE constant", async () => {
    const script = readFileSync("/home/ubuntu/konoha/scripts/akamaru.py", "utf-8");
    expect(script).toContain("PAUSED_FILE");
    expect(script).toContain("/opt/shared/kiba/paused-services.txt");
  });

  test("akamaru.py defines load_paused() function", async () => {
    const script = readFileSync("/home/ubuntu/konoha/scripts/akamaru.py", "utf-8");
    expect(script).toContain("def load_paused()");
    expect(script).toContain("PAUSED_FILE");
  });

  test("akamaru.py check_services() uses paused parameter", async () => {
    const script = readFileSync("/home/ubuntu/konoha/scripts/akamaru.py", "utf-8");
    expect(script).toContain("def check_services(paused:");
    expect(script).toContain("if svc in paused or short in paused:");
    expect(script).toContain("continue");
  });

  test("akamaru.py check_tmux_sessions() uses paused parameter", async () => {
    const script = readFileSync("/home/ubuntu/konoha/scripts/akamaru.py", "utf-8");
    expect(script).toContain("def check_tmux_sessions(paused:");
    expect(script).toContain("if session in paused:");
  });

  test("akamaru.py check_konoha() checks paused agents", async () => {
    const script = readFileSync("/home/ubuntu/konoha/scripts/akamaru.py", "utf-8");
    expect(script).toContain("async def check_konoha(paused:");
    expect(script).toContain("if aid in paused:");
    expect(script).toContain("continue");
  });

  test("akamaru.py main() loads paused and passes to all check functions", async () => {
    const script = readFileSync("/home/ubuntu/konoha/scripts/akamaru.py", "utf-8");
    expect(script).toContain("paused = load_paused()");
    expect(script).toContain("check_services(paused)");
    expect(script).toContain("check_tmux_sessions(paused)");
    expect(script).toContain("check_konoha(paused)");
  });
});
