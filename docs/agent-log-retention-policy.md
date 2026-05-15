# Agent runtime log retention policy

## Purpose

Agent runtimes (Codex, Claude, OpenCode) accumulate unbounded local state — SQLite databases, session traces, TUI logs, history files, cache artifacts. Without retention limits, a single runtime can grow large enough to make agent startup unreliable and watchdog diagnosis misleading. This policy defines bounded retention for all agent-associated log and state files.

## Principles

- **Idempotency** — cleanup must be safe to run repeatedly at any time
- **Active-runtime safety** — never rotate live SQLite files while the owning process is running
- **Hard size caps** — large files are truncated from the tail (oldest data) when they exceed thresholds
- **Age-based cleanup** — stale session/tmp/cache files are removed after a defined TTL
- **Sensitive data minimization** — retention limits are intentionally short; logs may contain secrets, prompts, and session data
- **Observability** — every run produces a machine-readable JSON report with reclaimed bytes and skipped actions
- **No unrelated files** — cleanup is scoped to well-known paths; it never touches uncommitted repo changes or non-agent data

## Retention rules

| Component | Path | Rule | Safety guard |
|-----------|------|------|-------------|
| Codex SQLite logs | `~/.codex/logs_*.sqlite*` | Rotate to `rotated-logs/` when total > 1 GB | Skip if any Codex process is running |
| Codex rotated logs | `~/.codex/rotated-logs/` | Delete files older than 1 day | — |
| Codex sessions | `~/.codex/sessions/` | Delete files older than 30 days | — |
| Codex shell snapshots | `~/.codex/shell_snapshots/` | Delete files older than 14 days | — |
| Codex TUI log | `~/.codex/log/codex-tui.log` | Truncate to 50 MB when > 200 MB | — |
| Codex history | `~/.codex/history.jsonl` | Truncate to 10 MB when > 50 MB | — |
| Codex tmp | `~/.codex/tmp/`, `~/.codex/.tmp/` | Delete dirs older than 3 days | — |
| Claude projects | `~/.claude/projects/` | Delete files older than 30 days | — |
| Claude file-history | `~/.claude/file-history/` | Delete files older than 30 days | — |
| Claude history | `~/.claude/history.jsonl` | Truncate to 10 MB when > 50 MB | — |
| OpenCode logs | `~/.local/share/opencode/log/` | Delete files older than 14 days | — |
| OpenCode session diffs | `~/.local/share/opencode/storage/session_diff/` | Delete files older than 30 days | — |
| OpenCode cache | `~/.cache/opencode/` | Delete files older than 30 days | — |
| Watchdog logs | `/tmp/watchdog-*.log` | Truncate to 10 MB when > 50 MB | — |
| Tmux scrollback | all agent tmux sessions | `tmux clear-history` | Skip if tmux server not running |
| Agent workdir tmp | `/opt/shared/agent-workdirs/*/tmp/` | Delete files older than 7 days | — |
| Stale Konoha tmp | `/tmp/konoha-*` | Delete dirs older than 14 days | — |
| Journald | system journal | Vacuum: 1 GB / 14 days (runtime) + static 1 GB / 14 day cap | Configured via dropin |

## Journald static configuration

A dropin at `/etc/systemd/journald.conf.d/konoha.conf` sets:

- `SystemMaxUse=1G` — hard 1 GB ceiling
- `MaxRetentionSec=14d` — discard entries older than 14 days
- `MaxFileSec=7d` — rotate individual journal files every 7 days

The runtime `journalctl --vacuum-size=1G --vacuum-time=14d` in the retention script provides a second enforcement layer.

## Enforcement

The retention script runs daily at 04:20 MSK via `konoha-agent-log-retention.timer` (systemd, Persistent=true). Operators can also invoke it manually:

```
./scripts/konoha-agent-log-retention.sh --json            # live run
DRY_RUN=1 ./scripts/konoha-agent-log-retention.sh --json  # dry-run
```

## Deployment

See `scripts/deploy-log-retention.sh` for the idempotent installation procedure.
