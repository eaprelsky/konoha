#!/bin/bash
# Claude Chat Agent Service
# Runs Claude Code #2 in tmux, auto-restarts every 2 hours to reset context.

SESSION="claude-chat"
RESTART_INTERVAL=7200  # 2 hours in seconds
MCP_CONFIG="/home/ubuntu/telethon-mcp/.mcp.json"

PROMPT='Прочитай /home/ubuntu/CLAUDE.md. Ты Claude Agent #2 — автономный мониторщик Telegram-чатов. Используй MCP telethon-channel. Запусти /loop 10s для проверки tg_read_new. Если action_hint=respond — ответь через tg_reply. Если observe — запомни. Пиши по-русски как коллега, без маркдауна. Не выдумывай факты.'

while true; do
    echo "[$(date)] Starting Claude Chat Agent..."

    # Kill old session if exists
    tmux kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    # Ensure bus is running
    if ! pgrep -f "telethon-mcp/bus.py" > /dev/null; then
        echo "[$(date)] Starting bus..."
        # Remove stale journal
        rm -f /opt/shared/telegram_session.session-journal
        PYTHONUNBUFFERED=1 python3 -u /home/ubuntu/telethon-mcp/bus.py > /tmp/tg-bus.log 2>&1 &
        sleep 3
    fi

    # Create tmux session
    tmux new-session -d -s "$SESSION" -x 200 -y 50

    # Launch Claude Code
    tmux send-keys -t "$SESSION" "claude --dangerously-skip-permissions --mcp-config $MCP_CONFIG" Enter
    sleep 15

    # Confirm trust
    tmux send-keys -t "$SESSION" Enter
    sleep 15

    # Send initial prompt
    tmux send-keys -t "$SESSION" "$PROMPT" Enter

    echo "[$(date)] Claude Chat Agent started. Will restart in ${RESTART_INTERVAL}s."
    sleep "$RESTART_INTERVAL"

    echo "[$(date)] Restarting Claude Chat Agent (context reset)..."
    tmux send-keys -t "$SESSION" C-c
    sleep 2
    tmux send-keys -t "$SESSION" "/exit" Enter
    sleep 3
done
