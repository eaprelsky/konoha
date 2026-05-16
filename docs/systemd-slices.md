# Konoha Systemd Slice Layout

Issue #781 splits the protected Konoha control plane from managed interactive
agents and their MCP children.

## Slice Model

| Slice | Runtime owner | Policy |
| --- | --- | --- |
| `konoha.slice` | Parent for all Konoha-managed runtime slices | Parent cap: `MemoryHigh=5500M`, `MemoryMax=6500M`, `CPUWeight=200`, `CPUQuota=600%` |
| `konoha-core.slice` | `konoha.service` only | Protected API/bus budget: `MemoryHigh=900M`, `MemoryMax=1200M`, `CPUWeight=300`, `CPUQuota=200%` |
| `konoha-connectors.slice` | Telegram bus/packers, Naruto, Sasuke, connector watchdogs | Always-on connector budget: `MemoryHigh=1600M`, `MemoryMax=2200M`, `CPUWeight=250`, `CPUQuota=300%` |
| `konoha-agents.slice` | Akamaru, Kiba, optional monitor workers | Optional monitor budget: `MemoryHigh=900M`, `MemoryMax=1200M`, `CPUWeight=120`, `CPUQuota=175%` |
| `konoha-qa.slice` | Kakashi, Shikadai, lifecycle-managed SDD/QA agents, TestBench | On-demand worker budget: `MemoryHigh=1200M`, `MemoryMax=1800M`, `CPUWeight=100`, `CPUQuota=200%` |
| `konoha-infra.slice` | Reserved for Redis/Postgres when those units are moved under Konoha-owned accounting | Infra budget: `MemoryHigh=1500M`, `MemoryMax=2500M`, `CPUWeight=200`, `CPUQuota=250%` |

The lifecycle API still owns `startAgent()`/`stopAgent()`, and systemd wrapper
units still call `scripts/agent-api-service.sh <id>`. The important #781 change
is that `src/agent/process.ts` starts tmux through a transient scope:

```bash
sudo -n systemd-run --scope --collect \
  --unit=konoha-agent-<id> \
  --slice=<konoha-connectors|konoha-agents|konoha-qa>.slice \
  --uid=ubuntu --gid=ubuntu \
  tmux -L <id> new-session ...
```

That scope owns the tmux server, the interactive runtime, and MCP child
processes. Konoha core only performs the lifecycle API request.

## Before Snapshot

Before #781, live accounting showed managed agents and MCP children inside the
core API cgroup:

```text
Unit konoha.service (/system.slice/konoha.service):
├─ tmux -L shino new-session ...
├─ claude --model deepseek-v4-pro ...
├─ tmux -L naruto new-session ...
├─ node /opt/shared/comind-template/mcp/bitrix24-mcp-server/build/index.js
├─ tmux -L kakashi new-session ...
├─ node /home/ubuntu/.npm-global/bin/codex --model gpt-5.5
└─ /home/ubuntu/.bun/bin/bun run core/src/server.ts
```

`systemctl show` also reported all active units in `system.slice`, with
`konoha.service` at `MemoryMax=infinity` and `CPUQuota=infinity`.

## Expected After Snapshot

After installing these units and restarting affected services:

```bash
sudo install -m 0644 konoha.service /etc/systemd/system/konoha.service
sudo install -m 0644 systemd/konoha*.slice /etc/systemd/system/
sudo install -m 0644 systemd/*.service /etc/systemd/system/
sudo install -m 0644 konoha-testbench/konoha-testbench.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart konoha.service
sudo systemctl restart agent-naruto.service agent-sasuke.service agent-kiba.service
```

Expected accounting:

```text
/konoha.slice/konoha-core.slice/konoha.service
/konoha.slice/konoha-connectors.slice/agent-naruto.service
/konoha.slice/konoha-connectors.slice/agent-sasuke.service
/konoha.slice/konoha-agents.slice/agent-kiba.service
/konoha.slice/konoha-qa.slice/konoha-agent-kakashi.scope
/konoha.slice/konoha-qa.slice/konoha-agent-shikadai.scope
```

`systemd-cgtop` should show core, connectors, optional monitor workers, and QA
workers as separate rows. Restarting `agent-kakashi.service`,
`agent-managed@shino.service`, or `agent-watchdog-lifecycle.service` must not
restart `konoha.service`.

## Healthcheck

`scripts/healthcheck-system.py` now reports:

- `slice.<name>` budget checks for MemoryHigh, MemoryMax, CPUWeight, and finite CPUQuota.
- `service_slice.<service>` checks that known services are assigned to their intended slice.
- Disabled optional monitor slices as healthy when policy disables them.

Run:

```bash
python3 scripts/healthcheck-system.py
```

## Rollback

Runtime scope wrapping can be disabled without data loss:

```bash
sudo systemctl set-environment KONOHA_AGENT_SYSTEMD_SCOPE=0
sudo systemctl restart konoha.service
```

For a full unit rollback, remove `Slice=`, `MemoryHigh=`, `MemoryMax=`,
`CPUWeight=`, and `CPUQuota=` overrides from the affected units, run
`sudo systemctl daemon-reload`, and restart only the changed units. Agent state
remains in Redis and tmux sessions can be stopped through the lifecycle API
before rollback if clean accounting is required.
