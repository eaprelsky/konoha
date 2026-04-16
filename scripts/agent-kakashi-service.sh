#!/bin/bash
set -a; source /home/ubuntu/.agent-env; set +a
unset OPENAI_API_KEY OPENROUTER_API_KEY CHATBOT_OPENROUTER_KEY OPENROUTER_MODEL CHATBOT_OPENROUTER_MODEL
source /home/ubuntu/konoha/scripts/agent-monitor.sh
BASE_PATH="/usr/local/bin:$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.bun/bin:/usr/local/sbin:/usr/bin:/sbin:/bin"

SESSION="kakashi"
RESTART_INTERVAL=7200

while true; do
    echo "[$(date)] Starting Kakashi (Codex Agent #8)..."
    tmux -L "$SESSION" kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    tmux -L "$SESSION" new-session -d -s "$SESSION" -c /opt/shared/agent-workdirs/kakashi -x 200 -y 50
    export PATH="$BASE_PATH"
    tmux -L "$SESSION" send-keys -t "$SESSION" "export PATH=\"$BASE_PATH\"; codex --no-alt-screen -m gpt-5.4 --dangerously-bypass-approvals-and-sandbox -C /opt/shared/agent-workdirs/kakashi" Enter

    /home/ubuntu/konoha/scripts/wait-for-prompt.sh "$SESSION" 120 "$SESSION"

    tmux -L "$SESSION" send-keys -t "$SESSION" 'Прочитай AGENTS.md. Ты Какаши - мастер багфиксинга Конохи, работаешь на Codex с моделью gpt-5.4. Потом жди - watchdog будет доставлять задания. Пиши по-русски.'
    sleep 1
    tmux -L "$SESSION" send-keys -t "$SESSION" Enter

    echo "[$(date)] Kakashi started. Monitoring tmux session (max ${RESTART_INTERVAL}s)..."
    ELAPSED=0
    while [ "$ELAPSED" -lt "$RESTART_INTERVAL" ]; do
        sleep 30
        ELAPSED=$((ELAPSED + 30))
        if ! tmux -L "$SESSION" has-session -t "$SESSION" 2>/dev/null; then
            echo "[$(date)] tmux session '$SESSION' is dead. Exiting for systemd restart."
            break
        fi
        if ! tmux -L "$SESSION" list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | xargs -I{} pgrep -P {} -f "codex|node .*codex" > /dev/null 2>&1; then
            echo "[$(date)] codex process not found in tmux. Exiting for systemd restart."
            break
        fi
    done
    echo "[$(date)] Restarting Kakashi (context reset or healthcheck fail)..."
done
