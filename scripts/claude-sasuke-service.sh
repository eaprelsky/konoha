#!/bin/bash
set -a; source /home/ubuntu/.agent-env; set +a

SESSION="sasuke"
RESTART_INTERVAL=7200
MCP_CONFIG="/home/ubuntu/telethon-mcp/.mcp-sasuke.json"

# Ensure bus is running
if ! pgrep -f "telethon-mcp/bus.py" > /dev/null; then
    rm -f /opt/shared/telegram_session.session-journal
    PYTHONUNBUFFERED=1 python3 -u /home/ubuntu/telethon-mcp/bus.py > /tmp/tg-bus.log 2>&1 &
    sleep 3
fi

while true; do
    echo "[$(date)] Starting Sasuke (Claude Agent #2)..."
    tmux -L "$SESSION" kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    tmux -L "$SESSION" new-session -d -s "$SESSION" -x 200 -y 50
    tmux -L "$SESSION" send-keys -t "$SESSION" "claude --dangerously-skip-permissions --mcp-config $MCP_CONFIG" Enter
    sleep 15
    tmux -L "$SESSION" send-keys -t "$SESSION" Enter
    /home/ubuntu/scripts/wait-for-prompt.sh "$SESSION" 90 "$SESSION"
    # Enable bypass permissions mode (--dangerously-skip-permissions does not auto-enable in-session)
    tmux -L "$SESSION" send-keys -t "$SESSION" BTab
    sleep 1
    SASUKE_PROMPT='Прочитай /home/ubuntu/CLAUDE.md. Ты Саске (Claude Agent #2), мониторщик Telegram через user account. АРХИТЕКТУРА: Саске читает telegram:incoming (bus.py пишет из Telethon user account) и отвечает через python3 /home/ubuntu/tg-send-user.py <chat_id> "<text>" [reply_to] (пишет в telegram:outgoing → bus.py). Наруто читает telegram:bot:incoming и отвечает через tg-send.py. Первым делом зарегистрируйся на Коноха: konoha_register(id=sasuke, name=Sasuke (Agent #2), roles=[monitor], capabilities=[telegram-monitor, telethon], model=claude-sonnet-4-6). Watchdog доставляет сообщения автоматически — /loop не нужен. НЕ читай telegram:bot:incoming. Пиши по-русски как коллега.'
    tmux -L "$SESSION" send-keys -t "$SESSION" "$SASUKE_PROMPT" Enter

    echo "[$(date)] Sasuke started. Monitoring tmux session (max ${RESTART_INTERVAL}s)..."
    # Healthcheck loop — exit if tmux/claude dies, or after RESTART_INTERVAL
    ELAPSED=0
    while [ "$ELAPSED" -lt "$RESTART_INTERVAL" ]; do
        sleep 30
        ELAPSED=$((ELAPSED + 30))
        if ! tmux -L "$SESSION" has-session -t "$SESSION" 2>/dev/null; then
            echo "[$(date)] tmux session '$SESSION' is dead. Exiting for systemd restart."
            break
        fi
        if ! tmux -L "$SESSION" list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | xargs -I{} pgrep -P {} claude > /dev/null 2>&1; then
            echo "[$(date)] claude process not found in tmux. Exiting for systemd restart."
            break
        fi
    done
    echo "[$(date)] Restarting Sasuke (context reset or healthcheck fail)..."
done
