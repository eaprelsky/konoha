#!/bin/bash
# agent-monitor.sh — shared monitoring loop for agent launcher scripts.
#
# Source this file and call monitor_agent() after starting the tmux session.
#
# Usage:
#   source /home/ubuntu/konoha/scripts/agent-monitor.sh
#   monitor_agent "$SESSION" "$RESTART_INTERVAL"
#
# monitor_agent exits when:
#   - the tmux session disappears (systemd restarts the service)
#   - the agent process inside tmux exits
#   - RESTART_INTERVAL seconds have elapsed (fresh-context restart)

monitor_agent() {
    local SESSION="${1:?SESSION required}"
    local RESTART_INTERVAL="${2:-7200}"

    echo "[$(date)] Monitoring tmux session '$SESSION' (max ${RESTART_INTERVAL}s)..."
    local elapsed=0
    while true; do
        sleep 30
        elapsed=$((elapsed + 30))
        if ! tmux -L "$SESSION" has-session -t "$SESSION" 2>/dev/null; then
            echo "[$(date)] tmux session '$SESSION' is dead. Exiting for systemd restart."
            break
        fi
        if ! tmux -L "$SESSION" list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | xargs -I{} pgrep -P {} -f "codex|claude|cursor-agent|node .*codex|opencode" > /dev/null 2>&1; then
            echo "[$(date)] agent process not found in tmux. Exiting for systemd restart."
            break
        fi
        if [ "$elapsed" -ge "$RESTART_INTERVAL" ]; then
            echo "[$(date)] Max session time reached (${RESTART_INTERVAL}s). Restarting for fresh context."
            break
        fi
    done
}
