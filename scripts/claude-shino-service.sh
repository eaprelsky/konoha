#!/bin/bash
set -a; source /home/ubuntu/.agent-env; set +a

SESSION="shino"
MCP_CONFIG="/home/ubuntu/konoha/agents/shino/.mcp-shino.json"
RESTART_INTERVAL=7200  # 2 hours max session

while true; do
    echo "[$(date)] Starting Shino (Claude Agent #5 - QA Lead)..."
    tmux -L "$SESSION" kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    tmux -L "$SESSION" new-session -d -s "$SESSION" -x 200 -y 50
    tmux -L "$SESSION" send-keys -t "$SESSION" "claude --model claude-sonnet-4-6 --dangerously-skip-permissions --mcp-config $MCP_CONFIG" Enter
    /home/ubuntu/scripts/wait-for-prompt.sh "$SESSION" 90 "$SESSION"

    # Enable bypass permissions mode (--dangerously-skip-permissions does not auto-enable in-session)
    tmux -L "$SESSION" send-keys -t "$SESSION" BTab
    sleep 1

    SHINO_PROMPT='Прочитай /home/ubuntu/konoha/agents/shino/CLAUDE.md и /opt/shared/agent-memory/MEMORY.md. Ты Шино (Claude Agent #5) — архитектор тестирования Конохи. Зарегистрируйся: konoha_register(id=shino, name=Шино (Архитектор тестов), roles=[qa-lead], capabilities=[test-plan,bug-analysis,coordination]). Потом жди — watchdog будет доставлять триггеры из Коноха (shino:smoke, shino:regression, shino:plan, model=claude-sonnet-4-6). Пиши по-русски. Готов к работе.'
    tmux -L "$SESSION" send-keys -t "$SESSION" "$SHINO_PROMPT" Enter

    echo "[$(date)] Shino started. Monitoring tmux session (max ${RESTART_INTERVAL}s)..."
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
