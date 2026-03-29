#!/bin/bash
# Auto-patch grammy's shim.node.js in Telegram plugin to use proxy-aware fetch
# Run after plugin updates to restore proxy support
# Also kills duplicate bot instances that cause 409 Conflict

PLUGIN_DIR="$HOME/.claude/plugins/cache/claude-plugins-official/telegram"

# Kill duplicate bot instances (keep only the newest)
BOT_PIDS=$(pgrep -f "bun.*telegram.*start" 2>/dev/null | sort -n)
BOT_COUNT=$(echo "$BOT_PIDS" | wc -w)
if [ "$BOT_COUNT" -gt 1 ]; then
  # Keep the last (newest), kill the rest
  KILL_PIDS=$(echo "$BOT_PIDS" | head -n -1)
  for pid in $KILL_PIDS; do
    kill "$pid" 2>/dev/null && echo "Killed duplicate bot PID $pid"
  done
fi

for version_dir in "$PLUGIN_DIR"/*/; do
  SHIM="$version_dir/node_modules/grammy/out/shim.node.js"
  if [ -f "$SHIM" ]; then
    # Check if already patched
    if grep -q "globalThis.fetch" "$SHIM" 2>/dev/null; then
      continue
    fi
    cat > "$SHIM" << 'SHIMEOF'
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetch = exports.AbortController = void 0;
var abort_controller_1 = require("abort-controller");
Object.defineProperty(exports, "AbortController", { enumerable: true, get: function () { return abort_controller_1.AbortController; } });
var stream_1 = require("stream");
exports.fetch = async function(url, opts) {
    if (opts && opts.body && opts.body instanceof stream_1.Readable) {
        var chunks = [];
        for await (var chunk of opts.body) {
            chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
        }
        opts = Object.assign({}, opts, { body: Buffer.concat(chunks) });
        delete opts.agent;
    }
    if (opts) { delete opts.agent; delete opts.compress; }
    return globalThis.fetch(url, opts);
};
SHIMEOF
    echo "Patched: $SHIM"
  fi
done
