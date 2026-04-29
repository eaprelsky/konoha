# Watchdog architecture

Three watchdog implementations deliver Konoha bus messages to agent tmux sessions. They share core logic via extracted modules but serve different consumers.

## Implementations

### 1. `watchdog.py` (universal watchdog, 362 lines)

Entry point for config-driven agents. Loads per-agent JSON from `scripts/agent-configs/{agent}.json`. Uses named tmux sockets (`-L {session}`).

**Consumers**: naruto, sasuke (and any agent with a config file).

**Imports from**: `watchdog_tmux`, `watchdog_format`, `watchdog_sources`

**Unique features**:
- Config-driven source selection (SSE, TG file, TG Redis, reactions, GitHub)
- Kakashi-specific scan-only batch dropping when agent is busy
- Health monitor with stuck-delivery detection and self-exit

### 2. `watchdog_base.py` (shared library, 586 lines)

Module-level config pattern: per-agent scripts set `AGENT_ID`, `TMUX_SESSION`, etc. before calling `run_watchdog()`.

**Consumers**: guy and other agents with dedicated `watchdog-{agent}.py` scripts that `import watchdog_base as _b`.

**Imports from**: `watchdog_tmux` (all tmux functions), `watchdog_format` (noise filter, text sanitization)

**Unique features** (not in shared modules):
- **Desync recovery (#505)**: auto-restarts agent via lifecycle API when unresponsive past `IDLE_TIMEOUT_SEC`. Resets retry budget on successful delivery.
- **Circuit breaker**: discards new events while agent is frozen (`CIRCUIT_BREAKER_DURATION` > 0).
- **On-demand wake**: starts agent via lifecycle API if tmux session is dead (`WAKE_TIMEOUT_SEC` > 0).
- **SSE_MAX_REPLAY_AGE guard (#521)**: clears stale Last-Event-ID to prevent massive replay on reconnect.
- **KONOHA_TEXT_LIMIT truncation**: enforces char limit with "call konoha_read for full text" hint.

### 3. `watchdog-lifecycle.py` (standalone watchdog, 692 lines)

Independent implementation for lifecycle-managed agents. Auto-discovers agents via `/agents` API, excluding dedicated-watchdog agents (naruto, sasuke, kakashi, kiba, jiraiya). Uses aiohttp for SSE instead of curl.

**Consumers**: All non-dedicated lifecycle-managed agents (shino, hinata, etc.).

**Unique features**:
- **Auto-discovery**: fetches agent list from API, filters to running lifecycle-managed agents
- **Multi-agent**: watches multiple agents in a single process
- **Auto-push (#367)**: periodically pushes unpushed commits from `~/konoha` to origin/main
- **Redis stream support**: reads `redis_streams` from AgentDef for per-agent custom streams
- **aiohttp SSE**: uses aiohttp session instead of curl subprocess

## Shared modules (extracted from `watchdog.py`, #573)

### `watchdog_tmux.py` (186 lines)
Core tmux interaction: session liveness, pane capture, idle detection (Claude/Codex/Cursor/OpenCode prompts), message delivery with compacting wait, [Pasted text] dismissal, submit retries, and pane-change confirmation.

### `watchdog_format.py` (207 lines)
Noise filter (`is_session_noise`), text sanitization (`sanitize_message_text`), and multi-source batch formatting for naruto/sasuke.

### `watchdog_sources.py` (509 lines)
Event source watchers: Konoha SSE (curl-based), Telegram file tailing, Telegram reactions file, Redis stream consumers, GitHub Issues scanner. Includes shared health tracker.

## Why three implementations?

The duplication between `watchdog.py` and `watchdog_base.py` was resolved in #570 by making `watchdog_base` import from the shared modules. Remaining differences are genuine feature divergence:

| Feature | watchdog.py | watchdog_base.py | watchdog-lifecycle.py |
|---|---|---|---|
| Config model | JSON file | Module variables | API auto-discovery |
| Agent scope | One per process | One per process | Many per process |
| SSE client | curl (shared) | curl (own, SSE_MAX_REPLAY_AGE) | aiohttp |
| Desync recovery | No | Yes (#505) | Yes (simpler) |
| Circuit breaker | No | Yes | No |
| Auto-push | No | No | Yes (#367) |
| Redis streams | Via config | No | Via AgentDef |

`watchdog-lifecycle.py` cannot trivially merge into `watchdog_base.py` because:
1. It watches multiple agents in one process (watchdog_base is single-agent)
2. It uses aiohttp for SSE (different dependency, different error handling)
3. It has auto-push logic unique to the lifecycle watchdog
4. It auto-discovers agents from API rather than using static config

## Systemd supervision

All three watchdogs run under systemd with `Restart=always`. The TypeScript lifecycle API (`POST /agents/:id/start|stop|restart`) is the only control plane for agent lifecycle. Systemd unit files contain no business logic — they are thin wrappers that invoke the watchdog script.
