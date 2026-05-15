#!/usr/bin/env bash
# Konoha agent runtime log retention — bounded cleanup for Codex, Claude,
# OpenCode, watchdog, tmux, journald, and agent workdir transient data.
# refs: docs/agent-log-retention-policy.md, #795
set -uo pipefail

# ── Defaults (override via env for testing) ─────────────────────────────────
HOME_DIR="${HOME_DIR:-${HOME:-/home/ubuntu}}"
CODEX_DIR="${CODEX_DIR:-$HOME_DIR/.codex}"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME_DIR/.claude}"
OPENCODE_DIR="${OPENCODE_DIR:-$HOME_DIR/.local/share/opencode}"
OPENCODE_CACHE="${OPENCODE_CACHE:-$HOME_DIR/.cache/opencode}"
AGENT_WORKDIRS="${AGENT_WORKDIRS:-/opt/shared/agent-workdirs}"
AGENT_CONFIGS="${AGENT_CONFIGS:-/home/ubuntu/konoha/scripts/agent-configs}"
LOG_PREFIX="[konoha-agent-log-retention]"

DRY_RUN="${DRY_RUN:-0}"
JSON_MODE=0
ERRORS=0
declare -a SKIP_ENTRIES=()

usage() {
  cat <<'EOF'
Usage: konoha-agent-log-retention.sh [--json] [--dry-run] [-h|--help]

  --json       Emit machine-readable JSON report to stdout, logs to stderr.
  --dry-run    Report what would be done; do not modify files.
               (Also settable via DRY_RUN=1 env var.)
  -h, --help   Show this help.

Exit code: 0 on clean run, 1 if errors were recorded.
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)    JSON_MODE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage ;;
    *)         echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

# ── Logging ─────────────────────────────────────────────────────────────────
log() { printf '%s %s\n' "$LOG_PREFIX" "$*" >&2; }

add_skip() {
  local component="$1" reason="$2"
  log "skip component=$component reason=$reason"
  SKIP_ENTRIES+=("$(printf '{"component":"%s","reason":"%s"}' "$component" "$reason")")
}

add_error() {
  local component="$1" msg="$2"
  printf '%s ERROR component=%s %s\n' "$LOG_PREFIX" "$component" "$msg" >&2
  ERRORS=$((ERRORS + 1))
}

# ── File / dir helpers ──────────────────────────────────────────────────────
bytes_of() {
  [ -e "$1" ] || { echo 0; return 0; }
  du -sb "$1" 2>/dev/null | awk '{s+=$1} END {print s+0}' || echo 0
}

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '%s DRY-RUN: ' "$LOG_PREFIX" >&2
    printf '%q ' "$@" >&2
    printf '\n' >&2
  else
    "$@" 2>/dev/null || true
  fi
}

truncate_tail() {
  local file="$1" max_bytes="$2" keep_bytes="$3"
  [ -f "$file" ] || return 0
  local size
  size=$(stat -c%s "$file" 2>/dev/null || echo 0)
  [ "$size" -le "$max_bytes" ] && return 0
  log "truncate-tail file=$file size=$size keep=$keep_bytes"
  [ "$DRY_RUN" = "1" ] && return 0
  local tmp
  tmp=$(mktemp)
  if ! tail -c "$keep_bytes" "$file" > "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    add_error "truncate_tail" "tail failed for $file"
    return 1
  fi
  if ! cat "$tmp" > "$file" 2>/dev/null; then
    rm -f "$tmp"
    add_error "truncate_tail" "write failed for $file"
    return 1
  fi
  rm -f "$tmp"
}

remove_old_files() {
  local dir="$1" days="$2"
  [ -d "$dir" ] || return 0
  local count
  count=$(find "$dir" -type f -mtime "+$days" 2>/dev/null | wc -l)
  [ "$count" -eq 0 ] && return 0
  log "remove old files dir=$dir mtime=+$days count=$count"
  [ "$DRY_RUN" = "1" ] && return 0
  find "$dir" -type f -mtime "+$days" -delete 2>/dev/null || true
}

remove_old_dirs() {
  local dir="$1" days="$2"
  [ -d "$dir" ] || return 0
  local count
  count=$(find "$dir" -mindepth 1 -type d -mtime "+$days" 2>/dev/null | wc -l)
  [ "$count" -eq 0 ] && return 0
  log "remove old dirs dir=$dir mtime=+$days count=$count"
  [ "$DRY_RUN" = "1" ] && return 0
  find "$dir" -mindepth 1 -type d -mtime "+$days" -prune -exec rm -rf {} + 2>/dev/null || true
}

remove_old_glob() {
  local pattern="$1" days="$2"
  for p in $pattern; do
    [ -e "$p" ] || continue
    if [ "$(find "$p" -maxdepth 0 -mtime "+$days" 2>/dev/null | wc -l)" -gt 0 ]; then
      log "remove old glob path=$p mtime=+$days"
      [ "$DRY_RUN" = "1" ] || rm -rf "$p" 2>/dev/null || true
    fi
  done
}

# ── Measure before ──────────────────────────────────────────────────────────
before_codex=$(bytes_of "$CODEX_DIR")
before_claude=$(bytes_of "$CLAUDE_DIR")
before_opencode=$(bytes_of "$OPENCODE_DIR")
before_opencode_cache=$(bytes_of "$OPENCODE_CACHE")
before_watchdog=0
for f in /tmp/watchdog-*.log; do
  [ -f "$f" ] || continue
  before_watchdog=$(( before_watchdog + $(stat -c%s "$f" 2>/dev/null || echo 0) ))
done

log "start dry_run=$DRY_RUN json=$JSON_MODE codex_bytes=$before_codex claude_bytes=$before_claude opencode_bytes=$before_opencode"

# ── Journald ────────────────────────────────────────────────────────────────
before_journal=$(bytes_of /var/log/journal 2>/dev/null || echo 0)
if command -v journalctl >/dev/null 2>&1; then
  log "journald vacuum size=1G time=14d"
  run journalctl --vacuum-size=1G --vacuum-time=14d
fi
after_journal=$(bytes_of /var/log/journal 2>/dev/null || echo 0)
[ "$DRY_RUN" = "1" ] && after_journal="$before_journal"
recl_journal=$(( before_journal - after_journal ))
[ "$recl_journal" -lt 0 ] && recl_journal=0

# ── Codex ───────────────────────────────────────────────────────────────────
mkdir -p "$CODEX_DIR/rotated-logs"

# SQLite log rotation (inactive only)
codex_sqlite_bytes=0
for f in "$CODEX_DIR"/logs_*.sqlite "$CODEX_DIR"/logs_*.sqlite-wal "$CODEX_DIR"/logs_*.sqlite-shm; do
  [ -e "$f" ] || continue
  codex_sqlite_bytes=$(( codex_sqlite_bytes + $(stat -c%s "$f" 2>/dev/null || echo 0) ))
done

if [ "$codex_sqlite_bytes" -gt $((1024 * 1024 * 1024)) ]; then
  if pgrep -u "${USER:-ubuntu}" -f 'codex' >/dev/null 2>&1; then
    add_skip "codex_sqlite" "active Codex process (sqlite_bytes=$codex_sqlite_bytes)"
  else
    ts=$(date +%Y%m%d-%H%M%S)
    log "rotate codex sqlite logs bytes=$codex_sqlite_bytes ts=$ts"
    for f in "$CODEX_DIR"/logs_*.sqlite "$CODEX_DIR"/logs_*.sqlite-wal "$CODEX_DIR"/logs_*.sqlite-shm; do
      [ -e "$f" ] || continue
      run mv "$f" "$CODEX_DIR/rotated-logs/$(basename "$f").$ts"
    done
  fi
fi

remove_old_files "$CODEX_DIR/rotated-logs" 1
remove_old_files "$CODEX_DIR/shell_snapshots" 14
remove_old_files "$CODEX_DIR/sessions" 30
remove_old_dirs "$CODEX_DIR/tmp" 3
remove_old_dirs "$CODEX_DIR/.tmp" 3
truncate_tail "$CODEX_DIR/log/codex-tui.log" $((200 * 1024 * 1024)) $((50 * 1024 * 1024))
truncate_tail "$CODEX_DIR/history.jsonl" $((50 * 1024 * 1024)) $((10 * 1024 * 1024))

after_codex=$(bytes_of "$CODEX_DIR")
codex_recl=$(( before_codex - after_codex ))
[ "$codex_recl" -lt 0 ] && codex_recl=0

# ── Claude ──────────────────────────────────────────────────────────────────
remove_old_files "$CLAUDE_DIR/projects" 30
remove_old_files "$CLAUDE_DIR/file-history" 30
truncate_tail "$CLAUDE_DIR/history.jsonl" $((50 * 1024 * 1024)) $((10 * 1024 * 1024))

after_claude=$(bytes_of "$CLAUDE_DIR")
claude_recl=$(( before_claude - after_claude ))
[ "$claude_recl" -lt 0 ] && claude_recl=0

# ── OpenCode ────────────────────────────────────────────────────────────────
remove_old_files "$OPENCODE_DIR/log" 14
remove_old_files "$OPENCODE_DIR/storage/session_diff" 30
remove_old_files "$OPENCODE_CACHE" 30

after_opencode=$(bytes_of "$OPENCODE_DIR")
after_opencode_cache=$(bytes_of "$OPENCODE_CACHE")
opencode_recl=$(( before_opencode - after_opencode + before_opencode_cache - after_opencode_cache ))
[ "$opencode_recl" -lt 0 ] && opencode_recl=0

# ── Watchdog logs ───────────────────────────────────────────────────────────
for f in /tmp/watchdog-*.log; do
  [ -f "$f" ] || continue
  truncate_tail "$f" $((50 * 1024 * 1024)) $((10 * 1024 * 1024))
done

after_watchdog=0
for f in /tmp/watchdog-*.log; do
  [ -f "$f" ] || continue
  after_watchdog=$(( after_watchdog + $(stat -c%s "$f" 2>/dev/null || echo 0) ))
done
watchdog_recl=$(( before_watchdog - after_watchdog ))
[ "$watchdog_recl" -lt 0 ] && watchdog_recl=0

# ── Tmux history ────────────────────────────────────────────────────────────
tmux_recl=0
if command -v tmux >/dev/null 2>&1 && tmux info &>/dev/null 2>&1; then
  if [ -d "$AGENT_CONFIGS" ]; then
    for cfg in "$AGENT_CONFIGS"/*.json; do
      [ -f "$cfg" ] || continue
      session=$(python3 -c "import json; print(json.load(open('$cfg')).get('tmux_session',''))" 2>/dev/null || true)
      [ -n "$session" ] || continue
      if tmux has-session -t "$session" 2>/dev/null; then
        log "tmux clear-history session=$session"
        run tmux clear-history -t "$session"
      fi
    done
  fi
else
  add_skip "tmux" "tmux server not running"
fi

# ── Agent workdir tmp ───────────────────────────────────────────────────────
workdir_recl=0
if [ -d "$AGENT_WORKDIRS" ]; then
  for wd in "$AGENT_WORKDIRS"/*/tmp; do
    [ -d "$wd" ] || continue
    before_d=$(bytes_of "$wd")
    remove_old_files "$wd" 7
    after_d=$(bytes_of "$wd")
    workdir_recl=$(( workdir_recl + before_d - after_d ))
  done
fi

# ── Stale /tmp/konoha-* ─────────────────────────────────────────────────────
stale_tmp_recl=0
for d in /tmp/konoha-*; do
  [ -e "$d" ] || continue
  before_d=$(bytes_of "$d")
  remove_old_glob "$d" 14
  after_d=$(bytes_of "$d")
  stale_tmp_recl=$(( stale_tmp_recl + before_d - after_d ))
done

# ── Totals ──────────────────────────────────────────────────────────────────
total_recl=$(( codex_recl + claude_recl + opencode_recl + watchdog_recl + tmux_recl + workdir_recl + stale_tmp_recl + recl_journal ))

log "done codex_bytes=$after_codex claude_bytes=$after_claude opencode_bytes=$after_opencode total_reclaimed=$total_recl"

# ── JSON report ─────────────────────────────────────────────────────────────
if [ "$JSON_MODE" = "1" ]; then
  ts=$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S%z)

  # Build skipped array
  skipped_json="["
  _sep=
  for entry in "${SKIP_ENTRIES[@]}"; do
    [ -n "$_sep" ] && skipped_json+=","
    _sep=x
    skipped_json+="$entry"
  done
  skipped_json+="]"

  err_text="[]"
  if [ "$ERRORS" -gt 0 ]; then
    err_text="[{\"count\":$ERRORS}]"
  fi

  cat <<JEND
{
  "ts": "${ts}",
  "dry_run": $DRY_RUN,
  "reclaimed_bytes": {
    "codex": $codex_recl,
    "claude": $claude_recl,
    "opencode": $opencode_recl,
    "watchdog_logs": $watchdog_recl,
    "tmux_history": $tmux_recl,
    "workdir_tmp": $workdir_recl,
    "stale_konoha_tmp": $stale_tmp_recl,
    "journald": $recl_journal,
    "total": $total_recl
  },
  "skipped": $skipped_json,
  "errors": $err_text
}
JEND
fi

# ── Exit ────────────────────────────────────────────────────────────────────
if [ "$ERRORS" -gt 0 ]; then
  exit 1
fi
exit 0
