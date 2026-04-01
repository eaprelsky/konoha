#!/bin/bash
set -a; source /home/ubuntu/.agent-env; set +a

SESSION="inojin"
MCP_CONFIG="/home/ubuntu/konoha/agents/inojin/.mcp-inojin.json"
RESTART_INTERVAL=7200  # 2 hours max session

while true; do
    echo "[$(date)] Starting Inojin (Claude Agent #13 - Редактор Ноктюрны)..."
    tmux kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    tmux new-session -d -s "$SESSION" -x 200 -y 50
    tmux send-keys -t "$SESSION" "claude --model claude-haiku-4-5-20251001 --dangerously-skip-permissions --mcp-config $MCP_CONFIG" Enter
    sleep 20
    tmux send-keys -t "$SESSION" Enter
    sleep 10

    # Enable bypass permissions mode (--dangerously-skip-permissions does not auto-enable in-session)
    tmux send-keys -t "$SESSION" BTab
    sleep 1

    INOJIN_PROMPT='Прочитай /home/ubuntu/konoha/agents/inojin/CLAUDE.md. Ты Иноджин (Claude Agent #13) — редактор и фактчекер контента Ноктюрны. Зарегистрируйся: konoha_register(id=inojin, name=Иноджин (Редактор Ноктюрны), roles=[editor], capabilities=[factcheck,proofreading,style-review,verification], model=claude-haiku-4-5-20251001). Сообщи Ино что готов: konoha_send(from=inojin, to=ino, text="Иноджин онлайн, жду статьи на вычитку."). Жди статей от Ино через watchdog. Пиши по-русски.'
    tmux send-keys -t "$SESSION" "$INOJIN_PROMPT" Enter

    echo "[$(date)] Inojin started. Monitoring tmux session (max ${RESTART_INTERVAL}s)..."
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
