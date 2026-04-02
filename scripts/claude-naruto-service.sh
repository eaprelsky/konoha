#!/bin/bash
set -a; source /home/ubuntu/.agent-env; set +a

SESSION="naruto"
MCP_CONFIG=""  # Uses default plugins from ~/.claude

while true; do
    echo "[$(date)] Starting Naruto (Claude Agent #1)..."
    tmux -L "$SESSION" kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    # Start telegram-bot-service standalone (Grammy bot → Redis + jsonl)
    pkill -f 'telegram-bot-service/bot.ts' 2>/dev/null || true
    sleep 1
    cd /home/ubuntu/telegram-bot-service
    nohup bun run bot.ts > /tmp/telegram-bot-service.log 2>&1 &
    echo "[$(date)] telegram-bot-service started (PID $!)"
    cd /home/ubuntu

    tmux -L "$SESSION" new-session -d -s "$SESSION" -x 200 -y 50
    tmux -L "$SESSION" send-keys -t "$SESSION" 'claude --dangerously-skip-permissions' Enter
    /home/ubuntu/scripts/wait-for-prompt.sh "$SESSION" 90 "$SESSION"
    # Enable bypass permissions mode (--dangerously-skip-permissions does not auto-enable in-session)
    tmux -L "$SESSION" send-keys -t "$SESSION" BTab
    sleep 1
    # Initial prompt: read config, start polling, begin work
    tmux -L "$SESSION" send-keys -t "$SESSION" 'Прочитай /home/ubuntu/CLAUDE.md и /opt/shared/agent-memory/MEMORY.md. Ты Наруто (Claude Agent #1). Watchdog доставляет сообщения сам — /loop не нужен. Проверь незавершённые задачи из памяти и работай автономно.' Enter

    echo "[$(date)] Naruto started. Monitoring tmux session..."
    # Healthcheck loop — exit if tmux session or claude process dies
    while true; do
        sleep 30
        if ! tmux -L "$SESSION" has-session -t "$SESSION" 2>/dev/null; then
            echo "[$(date)] tmux session '$SESSION' is dead. Exiting for systemd restart."
            break
        fi
        if ! tmux -L "$SESSION" list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | xargs -I{} pgrep -P {} claude > /dev/null 2>&1; then
            echo "[$(date)] claude process not found in tmux. Exiting for systemd restart."
            break
        fi
    done
done
