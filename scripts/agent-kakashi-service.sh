#!/bin/bash
set -a; source /home/ubuntu/.agent-env; set +a
unset OPENAI_API_KEY OPENROUTER_API_KEY CHATBOT_OPENROUTER_KEY OPENROUTER_MODEL CHATBOT_OPENROUTER_MODEL
source /home/ubuntu/konoha/scripts/agent-monitor.sh
BASE_PATH="/usr/local/bin:$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.bun/bin:/usr/local/sbin:/usr/bin:/sbin:/bin"

SESSION="kakashi"
RESTART_INTERVAL=7200

while true; do
    echo "[$(date)] Starting Kakashi (GLM-5.1 via Claude Code)..."
    tmux -L "$SESSION" kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    tmux -L "$SESSION" new-session -d -s "$SESSION" -c /opt/shared/agent-workdirs/kakashi -x 200 -y 50
    export PATH="$BASE_PATH"
    tmux -L "$SESSION" send-keys -t "$SESSION" "cd /opt/shared/agent-workdirs/kakashi && claude --dangerously-skip-permissions" Enter

    # Wait for bypass permissions menu, then accept
    for i in $(seq 1 30); do
        if tmux -L "$SESSION" capture-pane -t "$SESSION" -p 2>/dev/null | grep -q "Yes, I accept"; then
            sleep 1
            tmux -L "$SESSION" send-keys -t "$SESSION" "2" Enter
            echo "[$(date)] Bypass permissions accepted after ${i}s"
            break
        fi
        sleep 1
    done

    /home/ubuntu/konoha/scripts/wait-for-prompt.sh "$SESSION" 120 "$SESSION"

    tmux -L "$SESSION" send-keys -t "$SESSION" 'Прочитай AGENTS.md. Ты Какаши - мастер багфиксинга Конохи, работаешь через Claude Code на GLM-5.1. Потом жди - watchdog будет доставлять задания. Пиши по-русски.'
    sleep 1
    tmux -L "$SESSION" send-keys -t "$SESSION" Enter

    monitor_agent "$SESSION" "$RESTART_INTERVAL"
done
