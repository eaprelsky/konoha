#!/bin/bash
set -a; source /home/ubuntu/.agent-env; set +a

SESSION="ibiki"
MCP_CONFIG="/home/ubuntu/konoha/agents/ibiki/.mcp-ibiki.json"
RESTART_INTERVAL=7200  # 2 hours max session

while true; do
    echo "[$(date)] Starting Ibiki (Claude Agent #9 - Security Pentester)..."
    tmux kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    tmux new-session -d -s "$SESSION" -x 200 -y 50
    tmux send-keys -t "$SESSION" "claude --model claude-sonnet-4-6 --dangerously-skip-permissions --mcp-config $MCP_CONFIG" Enter
    sleep 20
    # Confirm any MCP config change prompts
    tmux send-keys -t "$SESSION" Enter
    sleep 10

    # Enable bypass permissions mode (--dangerously-skip-permissions does not auto-enable in-session)
    tmux send-keys -t "$SESSION" BTab
    sleep 1

    IBIKI_PROMPT='Прочитай /home/ubuntu/konoha/agents/ibiki/CLAUDE.md и /opt/shared/agent-memory/MEMORY.md. Ты Ибики (Claude Agent #9) — специалист по безопасности Конохи. Зарегистрируйся: konoha_register(id=ibiki, name=Ибики (Безопасность), roles=[security], capabilities=[pentest,audit,scan,report]). Потом жди — watchdog будет доставлять задания (ibiki:scan, ibiki:audit, model=claude-sonnet-4-6). Пиши по-русски. Готов к аудиту.'
    tmux send-keys -t "$SESSION" "$IBIKI_PROMPT" Enter

    echo "[$(date)] Ibiki started. Monitoring tmux session (max ${RESTART_INTERVAL}s)..."
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
