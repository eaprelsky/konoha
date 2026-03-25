#!/usr/bin/env node
/**
 * Pre-Compact Hook (adapted from everything-claude-code)
 *
 * Saves current session state to memory before context compaction.
 * Ensures important context survives the compact.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(os.homedir(), '.claude', 'session-state.json');

try {
  const state = {
    timestamp: new Date().toISOString(),
    sessionId: process.env.CLAUDE_SESSION_ID || 'unknown',
    workingDir: process.cwd(),
    compactCount: 0,
  };

  // Read existing state to increment compact count
  try {
    const existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state.compactCount = (existing.compactCount || 0) + 1;
  } catch {}

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  process.stderr.write(`[pre-compact] State saved. Compact #${state.compactCount}\n`);
} catch (err) {
  process.stderr.write(`[pre-compact] Error: ${err.message}\n`);
}

// Pass through stdin to stdout
process.stdin.pipe(process.stdout);
