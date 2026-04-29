# Watchdog architecture

Active watchdogs deliver Konoha bus messages and side-channel queues to agent tmux sessions. Lifecycle ownership stays in the TypeScript lifecycle API; watchdogs are delivery adapters only.

## Implementations

### 1. Dedicated watchdog wrappers (`watchdog-naruto.py`, `watchdog-sasuke.py`, `watchdog-kakashi.py`, `watchdog-kiba.py`)

Permanent agents use small per-agent entrypoints under systemd:

- `agent-watchdog-naruto.service` → `scripts/watchdog-naruto.py`
- `agent-watchdog-sasuke.service` → `scripts/watchdog-sasuke.py`
- `agent-watchdog-kiba.service` → `scripts/watchdog-kiba.py`

Kakashi has a dedicated wrapper (`agent-watchdog-kakashi.service` → `scripts/watchdog-kakashi.py`) but is operated as an on-demand worker. The unit is disabled by default and started only for an explicit bugfix/workflow task.

Each wrapper configures `watchdog_base.py` and adds only the source-specific behavior it owns. This keeps Telegram bot delivery, Telegram userbot Redis streams, GitHub issue scanning, and Akamaru alerts explicit instead of hidden in one large universal process.

**Unique features**:
- Naruto: Telegram bot queue, reactions, owner-priority interrupt, Konoha echo dedup
- Sasuke: Telegram Redis stream, reactions, mark-read commands, stuck-delivery monitor
- Kakashi: Konoha SSE, GitHub issue scanner, auto-push loop, on-demand only
- Kiba: Akamaru alert delivery, wake-on-demand, circuit breaker, git-push review poller

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

### 3. `watchdog-lifecycle.py` (generic lifecycle watchdog, 691 lines)

Independent implementation for lifecycle-managed agents. The active systemd unit passes the watched set through `WATCHDOG_AGENTS` (`mirai,jiraiya,shino,hinata,ibiki,ino,inojin,guy,shikadai`). It uses aiohttp for SSE instead of curl.

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

### 4. `watchdog.py` (legacy universal watchdog, 362 lines)

`watchdog.py` is retained as a reference/non-active fallback for config-driven delivery. `scripts/healthcheck-system.py` checks that active known watchdog units do not point at this legacy entrypoint.

## Why keep separate implementations?

The duplication between `watchdog.py` and `watchdog_base.py` was resolved in #570 by making both use shared modules. Remaining differences are genuine feature divergence:

| Feature | dedicated wrappers + `watchdog_base.py` | `watchdog-lifecycle.py` | legacy `watchdog.py` |
|---|---|---|---|
| Config model | Module variables in small wrappers | `WATCHDOG_AGENTS` plus AgentDef streams | JSON file |
| Agent scope | One per process | Many per process | One per process |
| SSE client | curl with replay-age guard | aiohttp | curl via shared source module |
| Desync recovery | Yes (#505) | Yes (simpler) | No active production use |
| Circuit breaker | Optional per wrapper | No | No |
| Auto-push | Kakashi-specific | Lifecycle generic loop | Config-driven |
| Redis streams | Sasuke-specific | Via AgentDef | Via JSON config |

`watchdog-lifecycle.py` cannot trivially merge into `watchdog_base.py` because:
1. It watches multiple agents in one process (watchdog_base is single-agent)
2. It uses aiohttp for SSE (different dependency, different error handling)
3. It has auto-push logic unique to the lifecycle watchdog
4. It resolves the watched agent set from `WATCHDOG_AGENTS` and AgentDef metadata rather than per-agent module variables

## Systemd supervision

Active watchdogs run under systemd. The TypeScript lifecycle API (`POST /agents/:id/start|stop|restart`) is the only control plane for agent lifecycle. Systemd unit files contain no business logic beyond choosing the delivery adapter.
