#!/bin/bash
set -a; source /home/ubuntu/.agent-env; set +a

SESSION="jiraiya"
MCP_CONFIG="/home/ubuntu/konoha/agents/jiraiya/.mcp-jiraiya.json"
RESTART_INTERVAL=7200  # 2 hours max session

while true; do
    echo "[$(date)] Starting Jiraiya (Claude Agent #4 - Chronicler)..."
    tmux kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    tmux new-session -d -s "$SESSION" -x 200 -y 50
    tmux send-keys -t "$SESSION" "claude --dangerously-skip-permissions --mcp-config $MCP_CONFIG" Enter
    sleep 20
    # Confirm any MCP config change prompts
    tmux send-keys -t "$SESSION" Enter
    sleep 10

    # Enable bypass permissions mode (--dangerously-skip-permissions does not auto-enable in-session)
    tmux send-keys -t "$SESSION" BTab
    sleep 1

    JIRAIYA_PROMPT='Прочитай /home/ubuntu/konoha/agents/jiraiya/CLAUDE.md и /opt/shared/agent-memory/MEMORY.md. Ты Дзирайя (Claude Agent #4) — летописец Конохи. Зарегистрируйся: konoha_register(id=jiraiya, name=Дзирайя (Летописец), roles=[chronicler], capabilities=[classify,chronicle,digest], model=claude-sonnet-4-6). Потом жди — watchdog будет доставлять батчи из konoha:bus для классификации и записи в /opt/shared/jiraiya/. Пиши по-русски. Готов к работе.'
    tmux send-keys -t "$SESSION" "$JIRAIYA_PROMPT" Enter

    echo "[$(date)] Jiraiya started. Monitoring tmux session (max ${RESTART_INTERVAL}s)..."
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
