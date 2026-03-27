#!/bin/bash
set -a; source /home/ubuntu/.agent-env; set +a

SESSION="mirai"
MCP_CONFIG="/home/ubuntu/telethon-mcp/.mcp-mirai.json"

while true; do
    echo "[$(date)] Starting Mirai (Claude Agent #3 - Email/Data Processor)..."
    tmux kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    tmux new-session -d -s "$SESSION" -x 200 -y 50
    tmux send-keys -t "$SESSION" "CLAUDE_MODEL=claude-haiku-4-5-20251001 claude --dangerously-skip-permissions --mcp-config $MCP_CONFIG" Enter
    sleep 20
    # Send Enter to confirm any MCP config change prompts
    tmux send-keys -t "$SESSION" Enter
    sleep 10
    MIRAI_PROMPT='Прочитай /home/ubuntu/CLAUDE.md. Ты Мирай (Claude Agent #3) — пограничник Конохи. Обрабатываешь внешние данные (почту, CRM) и передаёшь суть Наруто и Саске через шину Коноха. Сначала зарегистрируйся: konoha_register(id=mirai, name=Мирай (Agent #3), roles=[data-processor], capabilities=[email,crm,bitrix24]). Потом запусти /loop 10m check_konoha_and_email — на каждом тике: 1) konoha_read для получения задач от Наруто/Саске, 2) проверь новые письма через email MCP (list_emails_metadata), 3, model=claude-haiku-4-5-20251001) если есть важные письма или задачи — обработай и отправь итог через konoha_send. Пиши по-русски как коллега. Отвечай кратко и по делу.'
    tmux send-keys -t "$SESSION" "$MIRAI_PROMPT" Enter

    echo "[$(date)] Mirai started. Monitoring tmux session..."
    while true; do
        sleep 30
        if ! tmux has-session -t "$SESSION" 2>/dev/null; then
            echo "[$(date)] tmux session '$SESSION' is dead. Exiting for systemd restart."
            break
        fi
        if ! tmux list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | xargs -I{} pgrep -P {} claude > /dev/null 2>&1; then
            echo "[$(date)] claude process not found in tmux. Exiting for systemd restart."
            break
        fi
    done
done
