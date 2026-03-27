#!/bin/bash
set -a; source /home/ubuntu/.agent-env; set +a

SESSION="kiba"
MCP_CONFIG="/home/ubuntu/konoha/agents/kiba/.mcp-kiba.json"
RESTART_INTERVAL=7200  # 2 hours max session

while true; do
    echo "[$(date)] Starting Kiba (Claude Agent #7 - System Guardian)..."
    tmux kill-session -t "$SESSION" 2>/dev/null
    sleep 2

    tmux new-session -d -s "$SESSION" -x 200 -y 50
    tmux send-keys -t "$SESSION" "claude --model claude-sonnet-4-6 --dangerously-skip-permissions --mcp-config $MCP_CONFIG" Enter
    sleep 20
    # Confirm any MCP config change prompts
    tmux send-keys -t "$SESSION" Enter
    sleep 10

    KIBA_PROMPT='Прочитай /home/ubuntu/konoha/agents/kiba/CLAUDE.md и /opt/shared/agent-memory/MEMORY.md. Ты Киба (Claude Agent #7) — страж системы Коноха. Зарегистрируйся: konoha_register(id=kiba, name=Киба (Страж), roles=[monitor], capabilities=[health-check,alert,diagnose,escalate]). Потом жди — Акамару будет присылать алерты через Коноха (kiba:alert, kiba:healthcheck, model=claude-sonnet-4-6). Пиши по-русски. Готов к дежурству.'
    tmux send-keys -t "$SESSION" "$KIBA_PROMPT" Enter

    echo "[$(date)] Kiba started. Monitoring tmux session (max ${RESTART_INTERVAL}s)..."
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
