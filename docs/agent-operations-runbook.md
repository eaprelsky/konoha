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

## Stop

Permanent agents are stopped through systemd:

```bash
sudo systemctl stop agent-<id>.service
```

On-demand agents are stopped through the lifecycle API:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $KONOHA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "http://127.0.0.1:3200/agents/<id>/stop"
```

To prevent auto-restart by the lifecycle watchdog:

```bash
sudo systemctl mask agent-<id>.service
sudo systemctl stop agent-watchdog-<id>.service
```

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

## Healthcheck

Run the operational healthcheck before delegating long-running work to Kakashi or after any incident:

```bash
cd /home/ubuntu/konoha
python3 scripts/healthcheck-system.py
```

Exit code `0` means there are no hard failures. `WARN` lines are degraded signals to watch; `FAIL` lines require action before delegation.

The healthcheck covers:
- `systemctl --failed` and core services: Konoha, Akamaru, Telegram bus/bot, context packer, vision packer, permanent agents, per-agent watchdogs
- Konoha `/health` and `/agents`
- Redis stream lag/pending/dead-letter for Telegram routing streams
- tmux session presence and obvious stuck signals for Naruto, Sasuke, Kakashi, Kiba
- shared credentials and trusted-user config without printing secrets

## Common Failures

Telegram not replying:
```bash
python3 scripts/healthcheck-system.py
journalctl -u telegram-bus -u telegram-context-packer -u telegram-vision-packer -n 120 --no-pager
sudo systemctl restart telegram-bus telegram-context-packer telegram-vision-packer
```

Trusted list empty or broken:
```bash
python3 scripts/validate-shared-config.py --require-credentials --require-trusted-users
python3 scripts/sync-trusted-users-from-yonote.py --dry-run
```

Agent tmux missing:
```bash
sudo systemctl restart agent-<id>.service
tmux -L <id> has-session -t <id>
```

Agent alive but not receiving messages:
```bash
sudo systemctl restart agent-watchdog-<id>.service
journalctl -u agent-watchdog-<id> -n 120 --no-pager
```

Redis stream pending or lag growing:
```bash
redis-cli XINFO GROUPS telegram:incoming
redis-cli XPENDING telegram:incoming sasuke
sudo systemctl restart agent-watchdog-sasuke telegram-context-packer telegram-vision-packer
```

## Verification

```bash
systemctl --failed --no-pager
systemctl is-active konoha akamaru agent-watchdog-lifecycle agent-naruto agent-sasuke agent-kakashi agent-kiba
python3 /home/ubuntu/konoha/scripts/healthcheck-system.py
python3 /home/ubuntu/konoha/scripts/pre-release-gate.py
```
