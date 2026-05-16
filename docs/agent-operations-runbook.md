# Agent Operations Runbook

Canonical lifecycle is owned by Konoha. Do not use retired files under `agents/systemd/` or `agents/scripts/agent-*-service.sh`.

Agent ids such as `naruto` and `sasuke` are runtime compatibility ids, not
product-facing names. Use `docs/agent-naming.md` when deciding whether a string
belongs in lifecycle/service tooling (`id`), customer UI (`name`), or local
persona copy (`display_alias`).

## Required Core And Optional Runtimes

ADR-004 makes `Советник` the required product core. Connector-owned runtimes
(`naruto`, `sasuke`) and optional workers (`kiba`, `kakashi`, `shino`, `hinata`,
`guy`, etc.) are compatibility/runtime actors, not mandatory product agents.

Deployments that enable connector-owned or optional runtimes supervise them with
systemd wrappers:

```bash
sudo systemctl status agent-naruto.service agent-sasuke.service agent-kiba.service
sudo systemctl restart agent-<id>.service
```

Each wrapper calls:

```bash
/home/ubuntu/konoha/scripts/agent-api-service.sh <id>
```

That script talks to the Konoha lifecycle API and ensures the tmux session exists.
The API starts tmux in a transient systemd scope under the agent's runtime slice,
so the tmux server, LLM runtime, and MCP child processes are not children of
`konoha.service`. Slice names and budgets are documented in
`docs/systemd-slices.md`.

## Control Plane Policy

Systemd is only a supervisor. It must not launch `claude`, `codex`, `opencode`, or `tmux` directly for managed agents. Permanent `agent-*.service` units must call `scripts/agent-api-service.sh <id>`, which reconciles the Konoha lifecycle API with the tmux session.

Delivery watchdogs are adapters, not lifecycle owners:

| Unit | Responsibility |
|------|----------------|
| `agent-watchdog-naruto.service` | Telegram bot queue + Konoha SSE delivery to Naruto |
| `agent-watchdog-sasuke.service` | Telegram userbot Redis streams + Konoha SSE delivery to Sasuke |
| `agent-watchdog-kakashi.service` | GitHub/Konoha delivery to Kakashi |
| `agent-watchdog-shikadai.service` | GitHub/Konoha architecture delegation to Shikadai |
| `agent-watchdog-kiba.service` | Akamaru/Konoha delivery to Kiba |
| `agent-watchdog-lifecycle.service` | Generic delivery for on-demand lifecycle-managed agents |

The shared watchdog core is `scripts/watchdog_base.py`. The legacy universal `scripts/watchdog.py` is retained as a non-active fallback/reference and is split into small modules; it must not be wired into active systemd units without a deliberate migration.

`python3 scripts/healthcheck-system.py` enforces this policy by checking permanent agent service entrypoints, known watchdog entrypoints, and source files over 1000 lines.
It also checks `konoha-core.slice`, connector/optional/QA slices, and known
service-to-slice assignments. Optional slices are healthy when the deployment
policy disables the corresponding optional monitor.

## On-Demand Workers

On-demand workers are normally inactive and must not carry the `autostart` tag
unless a deployment policy explicitly enables them. Current SDD workers are
Kakashi, Shikadai, Shino, Hinata, and Guy. Ordinary delivery uses only two
durable roles: Developer (Kakashi) and Reviewer (Shikadai). Shino, Hinata,
Guy, and Ibiki are optional specialist workers and must be assigned through
explicit workflow branches or reviewer/developer escalation, not as a hardcoded
default fleet.

Mirai is connector-owned; Jiraiya/Ino/Inojin are deprecated. Shikadai is the
default Reviewer for the architecture backlog path, while optional specialist
agents remain on-demand compatibility runtimes.

Start an on-demand agent through the Konoha lifecycle API:

```bash
source /home/ubuntu/.agent-env
curl -fsS -X POST \
  -H "Authorization: Bearer $KONOHA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "http://127.0.0.1:3200/agents/<id>/start"
```

Delivery for most on-demand agents is handled by `agent-watchdog-lifecycle.service`.
Kakashi and Shikadai currently keep dedicated GitHub watchdogs for the
Developer -> Reviewer lane so issue label delivery does not duplicate through
the generic lifecycle watchdog.

Kakashi is a special on-demand interactive worker. His dedicated systemd units exist for manual starts, but are disabled by default:

```bash
sudo systemctl disable --now agent-kakashi.service agent-watchdog-kakashi.service
sudo systemctl start agent-kakashi.service
sudo systemctl stop agent-kakashi.service agent-watchdog-kakashi.service
```

GitHub labels are Kakashi's canonical task intake for delegated code work. Add
`state:ready-for-dev` + `agent:kakashi` to exactly one ready issue to make the
dedicated watchdog deliver it. The scanner also accepts `state:in-progress` for
continuation/rework. GitHub assignee is not used as the routing signal. The
scanner skips issues with `state:done` or `state:blocked`, persists dispatched
issue numbers in `~/.cache/konoha/kakashi-github-dispatched.json`, and never
scans the whole open queue as implicit work.

`kakashi-batch` is decommissioned for architecture/lean backlog execution.
Do not use it as the normal path. Each ordinary issue moves through:
`state:ready-for-dev` + `agent:kakashi` -> Kakashi implements ->
`state:ready-for-review` + `agent:shikadai` -> Shikadai reviews architecture,
code, and required checks -> accept, request changes, or block -> close only
after reviewer acceptance.

GitHub is also Shikadai's compatibility intake for review and architecture
decomposition. Use `state:ready-for-review` + `agent:shikadai` for Developer
handoff review. Use `agent:shikadai` on an architecture-labelled issue when
the expected output is a decomposition, sequencing recommendation, acceptance
criteria, or risk review. Do not use reviewer routing for implementation tasks;
those should go to Kakashi through `state:ready-for-dev` + `agent:kakashi`.

Start the Shikadai reviewer path with:

```bash
source /home/ubuntu/.agent-env
curl -fsS -X POST \
  -H "Authorization: Bearer $KONOHA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "http://127.0.0.1:3200/agents/shikadai/start"
sudo systemctl start agent-watchdog-shikadai.service
```

If lifecycle is unavailable, manually start a Codex session in the Shikadai
workdir, read `agents/shikadai/AGENTS.md`, review the pushed commit, and report
the decision through Konoha.

When an agent is intentionally parked, add its short id and any dedicated units to `/opt/shared/kiba/paused-services.txt` so Akamaru suppresses expected inactive-state alerts.

## Stop

Enabled connector-owned or optional runtimes supervised by systemd are stopped through systemd:

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

Connector and optional monitor checks are deployment-policy driven. By default,
healthcheck keeps the current production posture with Telegram enabled:

```bash
KONOHA_HEALTH_ENABLED_CONNECTORS=telegram
KONOHA_HEALTH_ENABLED_OPTIONAL_MONITORS=akamaru,kakashi,kiba
```

For a fresh non-Telegram install, disable Telegram connector checks without
removing the healthcheck:

```bash
KONOHA_HEALTH_ENABLED_CONNECTORS=none python3 scripts/healthcheck-system.py
python3 scripts/healthcheck-system.py --policy-dry-run
```

The same values can live in `/opt/shared/konoha-health-policy.json`:

```json
{
  "enabled_connectors": ["telegram"],
  "enabled_optional_monitors": ["akamaru", "kakashi", "kiba"]
}
```

The healthcheck covers:
- `systemctl --failed` and core services: Konoha, Akamaru, Telegram bus/bot, context packer, vision packer, permanent agents, per-agent watchdogs
- Konoha `/health` and `/agents`
- Redis stream lag/pending/dead-letter for Telegram routing streams
- tmux session presence and obvious stuck signals for runtime ids `naruto`, `sasuke`, `kakashi`, `kiba`
- shared credentials and trusted-user config without printing secrets

Healthcheck and Akamaru are infrastructure monitor runtime. They collect raw
deployment state and may mention runtime ids. Operator-visible decisions such as
incident triage, recovery approval, stuck-work review, and post-incident
follow-up should be represented as workflow cases with business roles. See
`docs/monitor-reliability-boundary.md`.

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
redis-cli XINFO GROUPS telegram:bot:incoming
redis-cli XINFO GROUPS telegram:outgoing
redis-cli XPENDING telegram:incoming sasuke
redis-cli XPENDING telegram:bot:incoming naruto
redis-cli XPENDING telegram:outgoing claude-agents
sudo systemctl restart agent-watchdog-sasuke agent-watchdog-naruto telegram-bus telegram-context-packer telegram-vision-packer
```

Telegram stream ownership:

| Stream | Group | Owner | Recovery behavior |
|--------|-------|-------|-------------------|
| `telegram:bot:incoming` | `naruto` | `agent-watchdog-naruto` | Reads pending on startup, acks after tmux delivery |
| `telegram:incoming` | `sasuke` | `agent-watchdog-sasuke` | Reads pending on startup, acks after tmux delivery |
| `telegram:outgoing` | `claude-agents` | `telegram-bus` | Replays pending on startup; stale/poison sends go to `telegram:outgoing:dead_letter` |
| `telegram:needs_context` | `context-packer` | `telegram-context-packer` | Dead letters invalid context packs |
| `telegram:vision_requests` | `vision-packer` | `telegram-vision-packer` | Dead letters invalid vision packs |

Optional/legacy groups:

| Stream | Group | Owner | Policy |
|--------|-------|-------|--------|
| `telegram:incoming` | `claude-agents` | `telethon-channel` MCP tools | Optional pull channel; not a production delivery SLO. Prune zero-pending stale consumers, do not destroy while MCP channel tools are still configured. |

The old `telegram:incoming/sasuke-group` group is not owned by any active code path and may be deleted when `pending=0`.

Do not replay old bot backlog after migrating Naruto or changing ownership. Move the group to the current tail first:

```bash
redis-cli XGROUP SETID telegram:bot:incoming naruto '$'
sudo systemctl restart agent-watchdog-naruto
```

If `telegram:outgoing:dead_letter` is non-empty, inspect and either replay manually or archive and clear after triage:

```bash
redis-cli --json XRANGE telegram:outgoing:dead_letter - + COUNT 20
redis-cli DEL telegram:outgoing:dead_letter
```

Run a smoke gate after Telegram stream changes:

```bash
cd /home/ubuntu/konoha
scripts/telegram-smoke.sh
```

## Verification

```bash
systemctl --failed --no-pager
systemctl is-active konoha akamaru agent-watchdog-lifecycle agent-naruto agent-sasuke agent-kiba
python3 /home/ubuntu/konoha/scripts/healthcheck-system.py
cd /home/ubuntu/konoha
PATH=/home/ubuntu/.bun/bin:$PATH bun run preflight
```
