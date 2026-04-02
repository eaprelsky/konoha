#!/bin/bash
set -a; source /home/ubuntu/.agent-env; set +a

SESSION="guy"
MCP_CONFIG="/home/ubuntu/konoha/agents/guy/.mcp-guy.json"
RESTART_INTERVAL=7200  # 2 hours max session

while true; do
    echo "[$(date)] Starting Guy (Claude Agent #10)..."
    tmux -L "$SESSION" kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    tmux -L "$SESSION" new-session -d -s "$SESSION" -x 200 -y 50
    tmux -L "$SESSION" send-keys -t "$SESSION" "claude --model claude-haiku-4-5-20251001 --dangerously-skip-permissions --mcp-config $MCP_CONFIG" Enter
    sleep 20
    tmux -L "$SESSION" send-keys -t "$SESSION" Enter
    /home/ubuntu/scripts/wait-for-prompt.sh "$SESSION" 90 "$SESSION"

    # Enable bypass permissions mode (--dangerously-skip-permissions does not auto-enable in-session)
    tmux -L "$SESSION" send-keys -t "$SESSION" BTab
    sleep 1

    GUY_PROMPT='Прочитай /home/ubuntu/konoha/agents/guy/CLAUDE.md. Ты Гай (Claude Agent #10) — быстрый разработчик, помощник Какаши. Зарегистрируйся: konoha_register(id=guy, name=Гай (Разработчик), roles=[developer], capabilities=[translate,scaffold,search-replace,boilerplate], model=claude-haiku-4-5-20251001). Жди задач — watchdog доставит их через Коноха.'
    tmux -L "$SESSION" send-keys -t "$SESSION" "$GUY_PROMPT" Enter

    echo "[$(date)] Guy started. Monitoring tmux session (max ${RESTART_INTERVAL}s)..."
    elapsed=0
    while true; do
        sleep 30
        elapsed=$((elapsed + 30))
        if ! tmux -L "$SESSION" has-session -t "$SESSION" 2>/dev/null; then
            echo "[$(date)] tmux session '$SESSION' is dead. Exiting for systemd restart."
            break
        fi
        if ! tmux -L "$SESSION" list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | xargs -I{} pgrep -P {} claude > /dev/null 2>&1; then
            echo "[$(date)] claude process not found in tmux. Exiting for systemd restart."
            break
        fi
        if [ "$elapsed" -ge "$RESTART_INTERVAL" ]; then
            echo "[$(date)] Max session time reached. Restarting for fresh context."
            break
        fi
    done
done
