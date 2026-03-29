#!/bin/bash
# Watchdog — monitors agent heartbeats, detects recovery after restart.
# Called by check_konoha cron. Maintains state in /tmp/.
# Notifies Yegor via Telegram when a watched agent comes back online.

source /home/ubuntu/.agent-env 2>/dev/null

KONOHA_URL="${KONOHA_URL:-http://127.0.0.1:3200}"
KONOHA_HEADERS=(-s -H "Authorization: Bearer $KONOHA_TOKEN")
OWNER_CHAT_ID="${OWNER_CHAT_ID}"  # set in .agent-env
STATE_FILE="/tmp/konoha-agent-statuses.json"
OFFLINE_SINCE_FILE="/tmp/konoha-offline-since.json"
OFFLINE_THRESHOLD=150  # seconds before heartbeat is considered stale
MIN_OFFLINE_FOR_RECOVERY=180  # seconds offline before recovery is notified (avoids false alarms)

NOW=$(date +%s)
NOW_MS=$(( NOW * 1000 ))

# Fetch current agent list
AGENTS_JSON=$(curl "${KONOHA_HEADERS[@]}" "$KONOHA_URL/agents" 2>/dev/null)
if [[ -z "$AGENTS_JSON" || "$AGENTS_JSON" == "null" ]]; then
  echo "[watchdog] Could not reach Konoha" >&2
  exit 0
fi

# Compute effective status (online only if heartbeat < threshold)
CURRENT_STATUS=$(echo "$AGENTS_JSON" | python3 -c "
import sys, json
agents = json.load(sys.stdin)
now_ms = $NOW_MS
threshold_ms = $OFFLINE_THRESHOLD * 1000
result = {}
for a in agents:
    hb = a.get('lastHeartbeat', 0)
    status = 'online' if (now_ms - hb) < threshold_ms else 'offline'
    result[a['id']] = status
print(json.dumps(result))
" 2>/dev/null)

if [[ -z "$CURRENT_STATUS" ]]; then
  echo "[watchdog] Failed to parse agent statuses" >&2
  exit 0
fi

# Load previous statuses
PREV_STATUS="{}"
if [[ -f "$STATE_FILE" ]]; then
  PREV_STATUS=$(cat "$STATE_FILE")
fi

# Load offline-since tracking
OFFLINE_SINCE="{}"
if [[ -f "$OFFLINE_SINCE_FILE" ]]; then
  OFFLINE_SINCE=$(cat "$OFFLINE_SINCE_FILE")
fi

# Detect transitions and notify
python3 - <<EOF
import json, subprocess, sys, time

current = json.loads('$CURRENT_STATUS')
try:
    prev = json.loads('''$PREV_STATUS''')
except:
    prev = {}

try:
    offline_since = json.loads('''$OFFLINE_SINCE''')
except:
    offline_since = {}

now = $NOW
min_offline = $MIN_OFFLINE_FOR_RECOVERY

for agent_id, status in current.items():
    prev_status = prev.get(agent_id, 'unknown')

    # Track when agent first went offline
    if status == 'offline' and prev_status != 'offline':
        offline_since[agent_id] = now
        print(f"[watchdog] {agent_id} went offline", file=sys.stderr)

    # offline -> online: agent recovered — only notify if was offline long enough
    if prev_status == 'offline' and status == 'online':
        went_offline_at = offline_since.get(agent_id, now)
        offline_duration = now - went_offline_at
        offline_since.pop(agent_id, None)
        if offline_duration >= min_offline:
            msg = f"{agent_id} поднялся и онлайн (был offline {offline_duration:.0f}с)"
            print(f"[watchdog] Recovery detected: {agent_id} after {offline_duration:.0f}s", file=sys.stderr)
            subprocess.run(
                ['python3', '/home/ubuntu/tg-send.py', '$OWNER_CHAT_ID', msg],
                capture_output=True
            )
        else:
            print(f"[watchdog] {agent_id} back online after {offline_duration:.0f}s (below threshold, no notify)", file=sys.stderr)

    # Clear offline-since if agent is online
    if status == 'online':
        offline_since.pop(agent_id, None)

# Save updated offline-since
with open('$OFFLINE_SINCE_FILE', 'w') as f:
    json.dump(offline_since, f)
EOF

# Save current statuses for next run
echo "$CURRENT_STATUS" > "$STATE_FILE"
