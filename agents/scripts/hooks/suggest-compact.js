#!/usr/bin/env node
/**
 * Strategic Compact Suggester (adapted from everything-claude-code)
 *
 * Suggests /compact at logical intervals to prevent mid-task context loss.
 * Runs on PreToolUse for Edit/Write operations.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const THRESHOLD = parseInt(process.env.COMPACT_THRESHOLD || '50', 10);
const REMINDER_INTERVAL = 25;
const AGENT_ID = process.env.KONOHA_AGENT_ID || process.env.CLAUDE_SESSION_ID || 'naruto';
const COUNTER_FILE = path.join(os.tmpdir(), `claude-tool-count-${AGENT_ID}`);

// Reset threshold: if counter exceeds this, assume it accumulated across /new sessions
// and reset. Claude Code /new resets context but not /tmp files.
const MAX_COUNT = 500;

let count = 1;

try {
  if (fs.existsSync(COUNTER_FILE)) {
    const parsed = parseInt(fs.readFileSync(COUNTER_FILE, 'utf8').trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < MAX_COUNT) {
      count = parsed + 1;
    }
    // If parsed >= MAX_COUNT, count stays at 1 (auto-reset after /new accumulation)
  }
  fs.writeFileSync(COUNTER_FILE, String(count));
} catch {
  // ignore errors
}

if (count === THRESHOLD) {
  process.stderr.write(`[compact] ${THRESHOLD} tool calls — consider /compact if switching phases\n`);
}

if (count > THRESHOLD && (count - THRESHOLD) % REMINDER_INTERVAL === 0) {
  process.stderr.write(`[compact] ${count} tool calls — good checkpoint for /compact\n`);
}

// Pass through stdin to stdout (required for hooks)
process.stdin.pipe(process.stdout);
