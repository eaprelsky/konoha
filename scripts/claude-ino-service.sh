#!/bin/bash
set -a; source /home/ubuntu/.agent-env; set +a

SESSION="ino"
MCP_CONFIG="/home/ubuntu/konoha/agents/ino/.mcp-ino.json"
RESTART_INTERVAL=7200  # 2 hours max session

while true; do
    echo "[$(date)] Starting Ino (Claude Agent #12 - Nocturna Marketing)..."
    tmux kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    tmux new-session -d -s "$SESSION" -x 200 -y 50
    tmux send-keys -t "$SESSION" "claude --model claude-sonnet-4-6 --dangerously-skip-permissions --mcp-config $MCP_CONFIG" Enter
    sleep 20
    tmux send-keys -t "$SESSION" Enter
    sleep 10

    INO_PROMPT='Прочитай /home/ubuntu/konoha/agents/ino/CLAUDE.md и /opt/shared/agent-memory/MEMORY.md. Ты Ино Яманака (Claude Agent #12) — маркетолог и контент-стратег Ноктюрны. Зарегистрируйся: konoha_register(id=ino, name=Ино (Маркетолог Ноктюрны), roles=[marketing], capabilities=[content-strategy,copywriting,seo,analytics], model=claude-sonnet-4-6). Жди задач — watchdog доставит их из Коноха. Пиши по-русски.'
    tmux send-keys -t "$SESSION" "$INO_PROMPT" Enter

    echo "[$(date)] Ino started. Monitoring tmux session (max ${RESTART_INTERVAL}s)..."
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
