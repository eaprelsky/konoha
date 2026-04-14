#!/bin/bash
# Naruto startup script — lifecycle-managed via Konoha API (POST /agents/naruto/start)
# This script is kept as an emergency manual fallback only.
# Normal operation: Konoha lifecycle API creates the konoha-naruto tmux session.
# telegram-bot-service runs independently as telegram-bot.service

set -a; source /home/ubuntu/.agent-env; set +a
unset OPENAI_API_KEY OPENROUTER_API_KEY CHATBOT_OPENROUTER_KEY OPENROUTER_MODEL CHATBOT_OPENROUTER_MODEL

SESSION="naruto"
TMUX_SOCKET="naruto"
WORKDIR="/opt/shared/agent-workdirs/naruto"
MCP_CONFIG="$WORKDIR/.mcp.json"
RESTART_INTERVAL=7200  # 2 hours max session

while true; do
    echo "[$(date)] Starting Naruto (Codex Agent #1) — emergency fallback..."
    tmux -L "$TMUX_SOCKET" kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    mkdir -p "$WORKDIR"
    tmux -L "$TMUX_SOCKET" new-session -d -s "$SESSION" -c "$WORKDIR" -x 200 -y 50

    export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"
    tmux -L "$TMUX_SOCKET" send-keys -t "$SESSION" "export PATH=\"$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH\"; codex --no-alt-screen -m gpt-5.4 --dangerously-bypass-approvals-and-sandbox -C $WORKDIR" Enter

    /home/ubuntu/konoha/scripts/wait-for-prompt.sh "$SESSION" 120 "$TMUX_SOCKET"
    tmux -L "$TMUX_SOCKET" send-keys -t "$SESSION" 'Прочитай AGENTS.md и выполни startup sequence.'
    sleep 1
    tmux -L "$TMUX_SOCKET" send-keys -t "$SESSION" Enter

    echo "[$(date)] Naruto started in $SESSION. Monitoring (max ${RESTART_INTERVAL}s)..."
    elapsed=0
    while true; do
        sleep 30
        elapsed=$((elapsed + 30))
        if ! tmux -L "$TMUX_SOCKET" has-session -t "$SESSION" 2>/dev/null; then
            echo "[$(date)] tmux session '$SESSION' is dead. Exiting for systemd restart."
            break
        fi
        if ! tmux -L "$TMUX_SOCKET" list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | xargs -I{} pgrep -P {} -f "codex|node .*codex" > /dev/null 2>&1; then
            echo "[$(date)] codex process not found in tmux. Exiting for systemd restart."
            break
        fi
        if [ "$elapsed" -ge "$RESTART_INTERVAL" ]; then
            echo "[$(date)] Max session time reached. Restarting for fresh context."
            break
        fi
    done
done
