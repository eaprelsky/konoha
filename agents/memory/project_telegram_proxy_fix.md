---
name: Telegram plugin grammy proxy fix
description: Patched grammy's shim.node.js to fix photo uploads through HTTP proxy in bun
type: project
---

Patched grammy's fetch shim to fix sendPhoto failing through HTTP proxy.

**Why:** bun replaces node-fetch with its own implementation that ignores the `agent` option (used for proxy). Text messages worked but multipart file uploads hung indefinitely.

**How to apply:** The fix is in `/home/ubuntu/.claude/plugins/cache/claude-plugins-official/telegram/0.0.1/node_modules/grammy/out/shim.node.js` — replaces node-fetch with globalThis.fetch (bun native, respects HTTP_PROXY) and converts Node.js Readable streams to Buffer for compatibility. This patch may be overwritten if the plugin is updated — re-apply if photo sending breaks again.
