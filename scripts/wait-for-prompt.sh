#!/bin/bash
# wait-for-prompt.sh <session> [max_wait_sec] [socket_name]
# Waits until Claude shows the ❯ prompt in the tmux session
SESSION="$1"
MAX_WAIT="${2:-60}"
SOCKET="${3:-}"
elapsed=0

# Build tmux command with optional -L flag
if [ -n "$SOCKET" ]; then
    TMUX_CMD="tmux -L $SOCKET"
else
    TMUX_CMD="tmux"
fi

while [ "$elapsed" -lt "$MAX_WAIT" ]; do
    if $TMUX_CMD capture-pane -t "$SESSION" -p 2>/dev/null | grep -q "❯"; then
        echo "[$(date)] ❯ prompt detected in $SESSION after ${elapsed}s"
        exit 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
done
echo "[$(date)] WARNING: ❯ prompt not found in $SESSION after ${MAX_WAIT}s, proceeding anyway"
exit 1
