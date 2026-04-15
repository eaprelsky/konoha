#!/bin/bash
set -a; source /home/ubuntu/.agent-env; set +a

SESSION="kiba"
MCP_CONFIG="/home/ubuntu/konoha/agents/kiba/.mcp-kiba.json"
WORKDIR="/opt/shared/agent-workdirs/kiba"
RESTART_INTERVAL=7200  # 2 hours max session

while true; do
    echo "[$(date)] Starting Kiba (Claude Agent #7 - System Guardian)..."
    tmux -L "$SESSION" kill-session -t "$SESSION" 2>/dev/null
    sleep 2
    mkdir -p "$WORKDIR"
    cp /home/ubuntu/konoha/agents/kiba/AGENTS.md "$WORKDIR/AGENTS.md"

    tmux -L "$SESSION" new-session -d -s "$SESSION" -c "$WORKDIR" -x 200 -y 50
    tmux -L "$SESSION" send-keys -t "$SESSION" "cd $WORKDIR && claude --model claude-sonnet-4-6 --dangerously-skip-permissions --mcp-config $MCP_CONFIG" Enter

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

    /home/ubuntu/konoha/scripts/wait-for-prompt.sh "$SESSION" 90 "$SESSION"

    # Enable bypass permissions mode (--dangerously-skip-permissions does not auto-enable in-session)
    tmux -L "$SESSION" send-keys -t "$SESSION" BTab
    sleep 1

    KIBA_PROMPT='Прочитай AGENTS.md и /opt/shared/agent-memory/MEMORY.md. Ты Киба (Claude Agent #7) — страж системы Коноха. Зарегистрируйся: konoha_register(id=kiba, name=Киба (Страж), roles=[monitor], capabilities=[health-check,alert,diagnose,escalate], model=claude-sonnet-4-6). Потом жди — Акамару будет присылать алерты через Коноха (kiba:alert, kiba:healthcheck). Пиши по-русски. Готов к дежурству.'
    tmux -L "$SESSION" send-keys -t "$SESSION" "$KIBA_PROMPT"
    sleep 1
    tmux -L "$SESSION" send-keys -t "$SESSION" Enter

    echo "[$(date)] Kiba started. Monitoring tmux session (max ${RESTART_INTERVAL}s)..."
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
