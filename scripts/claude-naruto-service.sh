#!/bin/bash
# Naruto startup script — lifecycle-managed via Konoha API (POST /agents/naruto/start)
# This script is kept as an emergency manual fallback only.
# Normal operation: Konoha lifecycle API creates the konoha-naruto tmux session.
# telegram-bot-service runs independently as telegram-bot.service

set -a; source /home/ubuntu/.agent-env; set +a

SESSION="naruto"
TMUX_SOCKET="naruto"
WORKDIR="/opt/shared/agent-workdirs/naruto"
MCP_CONFIG="$WORKDIR/.mcp.json"
RESTART_INTERVAL=7200  # 2 hours max session

while true; do
    echo "[$(date)] Starting Naruto (Claude Agent #1) — emergency fallback..."
    tmux -L "$TMUX_SOCKET" kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    mkdir -p "$WORKDIR"
    tmux -L "$TMUX_SOCKET" new-session -d -s "$SESSION" -c "$WORKDIR" -x 200 -y 50

    if [ -f "$MCP_CONFIG" ]; then
        tmux -L "$TMUX_SOCKET" send-keys -t "$SESSION" "claude --model claude-sonnet-4-6 --dangerously-skip-permissions --mcp-config $MCP_CONFIG" Enter
    else
        tmux -L "$TMUX_SOCKET" send-keys -t "$SESSION" "claude --model claude-sonnet-4-6 --dangerously-skip-permissions" Enter
    fi

    /home/ubuntu/scripts/wait-for-prompt.sh "$SESSION" 90 "$TMUX_SOCKET"
    tmux -L "$TMUX_SOCKET" send-keys -t "$SESSION" BTab
    sleep 1
    tmux -L "$TMUX_SOCKET" send-keys -t "$SESSION" 'Прочитай CLAUDE.md и выполни startup sequence.' Enter

    echo "[$(date)] Naruto started in $SESSION. Monitoring (max ${RESTART_INTERVAL}s)..."
    elapsed=0
    while true; do
        sleep 30
        elapsed=$((elapsed + 30))
        if ! tmux -L "$TMUX_SOCKET" has-session -t "$SESSION" 2>/dev/null; then
            echo "[$(date)] tmux session '$SESSION' is dead. Exiting for systemd restart."
            break
        fi
        if ! tmux -L "$TMUX_SOCKET" list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | xargs -I{} pgrep -P {} claude > /dev/null 2>&1; then
            echo "[$(date)] claude process not found in tmux. Exiting for systemd restart."
            break
        fi
        if [ "$elapsed" -ge "$RESTART_INTERVAL" ]; then
            echo "[$(date)] Max session time reached. Restarting for fresh context."
            break
        fi
    done
done
