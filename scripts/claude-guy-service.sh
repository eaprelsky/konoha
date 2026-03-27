#!/bin/bash
set -a; source /home/ubuntu/.agent-env; set +a

SESSION="guy"
MCP_CONFIG="/home/ubuntu/konoha/agents/guy/.mcp-guy.json"
RESTART_INTERVAL=7200  # 2 hours max session

while true; do
    echo "[$(date)] Starting Guy (Claude Agent #10 - Kakashi Sub-Agent)..."
    tmux kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    tmux new-session -d -s "$SESSION" -x 200 -y 50
    tmux send-keys -t "$SESSION" "claude --model claude-haiku-4-5-20251001 --dangerously-skip-permissions --mcp-config $MCP_CONFIG" Enter
    sleep 20
    # Confirm any MCP config change prompts
    tmux send-keys -t "$SESSION" Enter
    sleep 10

    GUY_PROMPT='Read /home/ubuntu/konoha/agents/guy/CLAUDE.md and /opt/shared/agent-memory/MEMORY.md. You are Guy (Claude Agent #10) — Kakashis sub-agent for fast mechanical tasks. Register: konoha_register(id=guy, name=Guy (Kakashi Sub-Agent), roles=[developer], capabilities=[translate,scaffold,search-replace,boilerplate]). Then wait — watchdog will deliver guy:task commands from Kakashi. Use AGENT_LANGUAGE from /opt/shared/.owner-config. Ready.'
    tmux send-keys -t "$SESSION" "$GUY_PROMPT" Enter

    echo "[$(date)] Guy started. Monitoring tmux session (max ${RESTART_INTERVAL}s)..."
    elapsed=0
    while true; do
        sleep 30
        elapsed=$((elapsed + 30))
        if ! tmux has-session -t "$SESSION" 2>/dev/null; then
            echo "[$(date)] tmux session '$SESSION' is dead. Exiting for systemd restart."
            break
        fi
        if ! tmux list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | xargs -I{} pgrep -P {} claude > /dev/null 2>&1; then
            echo "[$(date)] claude process not found in tmux. Exiting for systemd restart."
            break
        fi
        if [ "$elapsed" -ge "$RESTART_INTERVAL" ]; then
            echo "[$(date)] Max session time reached. Restarting for fresh context."
            break
        fi
    done
done
