# Agent Operations Runbook

Canonical lifecycle is owned by Konoha. Do not use retired files under `agents/systemd/` or `agents/scripts/agent-*-service.sh`.

## Permanent Agents

Permanent agents are supervised by systemd wrappers:

```bash
sudo systemctl status agent-naruto.service agent-sasuke.service agent-kakashi.service agent-kiba.service
sudo systemctl restart agent-<id>.service
```

Each wrapper calls:

```bash
/home/ubuntu/konoha/scripts/agent-api-service.sh <id>
```

That script talks to the Konoha lifecycle API and ensures the tmux session exists.

## On-Demand Agents

On-demand agents are started through the Konoha lifecycle API:

```bash
source /home/ubuntu/.agent-env
curl -fsS -X POST \
  -H "Authorization: Bearer $KONOHA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "http://127.0.0.1:3200/agents/<id>/start"
```

Delivery for on-demand agents is handled by `agent-watchdog-lifecycle.service`.

## tmux

Every managed agent uses an isolated tmux socket and session named after the agent id:

```bash
tmux -L <id> has-session -t <id>
tmux -L <id> capture-pane -pt <id> | tail -80
tmux -L <id> send-keys -t <id> Enter
```

The old `konoha-<id>` session naming is retired.

## Recovery

Use the narrowest restart that matches the fault:

```bash
sudo systemctl restart agent-watchdog-<id>.service
sudo systemctl restart agent-<id>.service
sudo systemctl restart agent-watchdog-lifecycle.service
sudo systemctl restart akamaru.service
```

Do not start `claude`, `codex`, or `opencode` manually in a new tmux session. If a runtime must change, update the AgentDef (`runtime`, `model`, `fallback_runtime`) and restart through lifecycle.

## Verification

```bash
systemctl --failed --no-pager
systemctl is-active konoha akamaru agent-watchdog-lifecycle agent-naruto agent-sasuke agent-kakashi agent-kiba
python3 /home/ubuntu/konoha/scripts/pre-release-gate.py
```
