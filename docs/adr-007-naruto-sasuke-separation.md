# ADR-007: Naruto and Sasuke Separation Guardrail

> Issue: #764 | Priority: P1 | Date: 2026-05-20 | Author: Kakashi
> Status: Proposed for review

## Context

The lean-runtime roadmap asks whether Naruto and Sasuke can be consolidated to
save one persistent agent process. The current deployment still uses both
runtime ids as compatibility surfaces for different Telegram endpoints:

- Naruto is the Telegram bot connector/orchestration runtime.
- Sasuke is the Telegram user-account connector/runtime.

The two runtimes share infrastructure, but they do not own the same ingestion
path. A direct merge risks routing regressions, identity confusion, watchdog
misdelivery, and data loss in Telegram streams. Any consolidation experiment
must therefore be reversible and must not weaken Sasuke chat ingestion.

## Decision

Keep Naruto and Sasuke separate for the current production architecture.

No merge, alias rewrite, watchdog consolidation, tmux rename, stream consumer
group change, or systemd unit consolidation is allowed until a separate
compatibility experiment is reviewed with:

- a written compatibility test matrix;
- explicit queue, lag, and health criteria;
- a rollback plan that restores both runtimes without data loss;
- proof that Sasuke user-account chat ingestion remains protected.

This ADR is a guardrail before any consolidation experiment, not approval to
run the experiment.

## Exclusive Responsibilities

### Naruto

Naruto exclusively owns the Telegram bot compatibility endpoint:

| Surface | Contract |
|---|---|
| Endpoint | `telegram-bot-naruto` |
| Inbound stream | `telegram:bot:incoming` |
| Consumer group | `naruto` |
| Runtime/session | `agent-naruto.service` / `naruto` |
| Watchdog | `agent-watchdog-naruto.service` |
| Delivery behavior | Telegram bot queue, reactions, owner-priority interrupt, Konoha SSE delivery, echo dedup |

Naruto is also the current upstream orchestration/controller actor for the
architecture backlog lane. Pausing Naruto may delay operator-level dispatch,
acknowledgement, and escalation messages even when GitHub labels remain intact.

### Sasuke

Sasuke exclusively owns the Telegram user-account compatibility endpoint:

| Surface | Contract |
|---|---|
| Endpoint | `telegram-user-sasuke` |
| Inbound streams | `telegram:incoming`, `telegram:reaction_updates` |
| Consumer groups | `sasuke`, `sasuke-reactions` |
| Runtime/session | `agent-sasuke.service` / `sasuke` |
| Watchdog | `agent-watchdog-sasuke.service` |
| Delivery behavior | User-account stream delivery, reactions, mark-read commands, stuck-delivery monitor |
| Required MCP packs | `telethon-channel`, `bitrix24` |

Sasuke chat ingestion is production-critical. A Naruto pause or consolidation
experiment must not stop `agent-sasuke.service`, must not stop
`agent-watchdog-sasuke.service`, and must not rewrite the `sasuke` Redis
consumer groups.

## Shared Dependencies And Streams

Both runtimes depend on:

- Konoha API and bus at `KONOHA_URL`;
- `KONOHA_TOKEN` from the deployment environment;
- Redis streams and pub/sub;
- PostgreSQL shadow bus/message persistence;
- messenger connector catalog compatibility ids in
  `src/messenger-connectors.ts`;
- Action Spine outbound connector action `connector.send_message`;
- `konoha-connectors.slice` resource budget;
- Kiba/Akamaru and `scripts/healthcheck-system.py` for visibility.

Shared infrastructure does not make the runtime responsibilities equivalent.
The compatibility stream boundaries remain endpoint-scoped:

| Endpoint | Runtime | Stream/group |
|---|---|---|
| `telegram-bot-naruto` | Naruto | `telegram:bot:incoming` / `naruto` |
| `telegram-user-sasuke` | Sasuke | `telegram:incoming` / `sasuke` |
| `telegram-user-sasuke` reactions | Sasuke | `telegram:reaction_updates` / `sasuke-reactions` |

## Failure Modes If Naruto Is Paused

Pausing Naruto intentionally degrades only the bot/orchestration side. The
expected failure modes are:

- `telegram:bot:incoming` lag or pending entries grow for group `naruto`;
- direct bot-chat replies and owner-priority bot interrupts are delayed;
- Konoha bus messages addressed to Naruto wait for later delivery;
- architecture backlog dispatch/acknowledgement can stall because Naruto is the
  current controller actor;
- Kiba/Akamaru may warn on Naruto service or watchdog inactivity unless the
  pause is explicitly recorded as maintenance;
- user-facing confusion can occur if a merged runtime answers through the wrong
  Telegram identity.

These failure modes must not propagate to Sasuke. During a Naruto pause,
`telegram:incoming` and `telegram:reaction_updates` must continue to drain under
Sasuke groups.

## Temporary Naruto Pause Experiment

A temporary pause may be proposed only as a separate reviewed experiment. The
experiment must use a time-boxed maintenance window and capture baseline,
during-pause, and rollback measurements.

### Preconditions

- `agent-sasuke.service` and `agent-watchdog-sasuke.service` are active.
- `scripts/healthcheck-system.py` has no Telegram user-account blocker.
- `scripts/telegram-smoke.sh` passes or has a written, unrelated waiver.
- Baseline values are recorded for:
  - `XLEN telegram:bot:incoming`;
  - `XPENDING telegram:bot:incoming naruto`;
  - `XLEN telegram:incoming`;
  - `XPENDING telegram:incoming sasuke`;
  - `XLEN telegram:reaction_updates`;
  - `XPENDING telegram:reaction_updates sasuke-reactions`;
  - `XLEN telegram:outgoing:dead_letter`.

### Pause Procedure

1. Announce the maintenance window to Naruto, Sasuke, Kiba, and the operator.
2. Stop only Naruto runtime and delivery units:
   `agent-naruto.service` and `agent-watchdog-naruto.service`.
3. Do not stop Sasuke units, Telegram packers, Redis, Konoha, or outbound
   delivery services.
4. Do not change Redis consumer group ids during the observation window.
5. Observe for at most 10 minutes unless the reviewed experiment sets a shorter
   window.

### Abort Criteria

Abort and roll back immediately if any condition occurs:

- `telegram:incoming/sasuke` pending count grows above 0 and does not drain on
  the next health interval;
- `telegram:reaction_updates/sasuke-reactions` pending count grows above 0 and
  does not drain on the next health interval;
- `telegram:outgoing:dead_letter` increases;
- Konoha API, Redis, or PostgreSQL health becomes red;
- Sasuke watchdog reports stuck delivery or idle-with-messages;
- bot backlog exceeds the reviewed threshold for the maintenance window.

The default bot backlog threshold is 100 pending entries or 10 minutes of oldest
undelivered message age. A different threshold must be stated in the experiment
plan.

## Compatibility Test Matrix

Before any consolidation attempt, the proposal must pass at least:

```bash
bun test tests/messenger-connectors.test.ts tests/messenger-outbound.test.ts tests/tool-profiles.test.ts
python3 -m pytest tests/test_watchdog_naruto.py tests/test_watchdog_sasuke.py tests/test_telegram_event_bridge.py
scripts/telegram-smoke.sh
python3 scripts/healthcheck-system.py
```

The test report must explicitly prove:

- bot endpoint events still route to `telegram-bot-naruto` / Naruto;
- user-account events still route to `telegram-user-sasuke` / Sasuke;
- Sasuke keeps `telethon-channel` and `bitrix24` access;
- no runtime answers through the wrong Telegram identity;
- rollback can restore the prior service/watchdog layout without stream loss.

## Rollback Plan

Rollback is the default response to any failed pause or consolidation test.

1. Start the Naruto services:
   `sudo systemctl start agent-naruto.service agent-watchdog-naruto.service`.
2. Verify both Naruto units are active and the `naruto` tmux session exists.
3. Confirm Sasuke stayed active throughout rollback:
   `agent-sasuke.service`, `agent-watchdog-sasuke.service`, and `sasuke` tmux
   session must remain up.
4. Watch `XPENDING telegram:bot:incoming naruto` until it drains or the
   operator decides to skip stale bot backlog.
5. Run `scripts/telegram-smoke.sh` and `python3 scripts/healthcheck-system.py`.
6. If bot backlog must be skipped, use the existing Telegram stream runbook
   path only after operator approval:
   `redis-cli XGROUP SETID telegram:bot:incoming naruto '$'`, then restart
   `agent-watchdog-naruto.service`.

Rollback must not delete or reset Sasuke groups. If any Sasuke pending entries
remain after rollback, the experiment is failed and follow-up remediation must
target the user-account path before another consolidation attempt.

## Consequences

- Lean-runtime work may still reduce duplicate MCP packs and optional workers,
  but Naruto/Sasuke process consolidation remains blocked by this guardrail.
- Future connector refactors should migrate business behavior into workflow
  routing without changing the compatibility runtime ids in the same step.
- Service, watchdog, stream, and tmux compatibility names remain stable until a
  reviewed migration proves safe rollback.
