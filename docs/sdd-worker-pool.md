# Bounded SDD Worker Pool

Issue #791 makes the SDD dev/test lane explicit and bounded. The default
delivery model remains two-role:

1. Kakashi implements one delegated issue.
2. Shikadai reviews, decides required checks, requests changes or closes.

Guy, Shino, Hinata, and Ibiki are optional specialists. They are not mandatory
pipeline stages and must not be started just because Kakashi pushed a fix.

Machine-readable contract: `docs/sdd-worker-pool.json`.
Architecture delivery responsibilities are defined in
`docs/konoha-delivery-model.md`.

## Pool Limits

| Limit | Value |
| --- | --- |
| Maximum active SDD workers | 2 |
| Maximum active specialists | 1 |
| Idle mission TTL | 1800 seconds |
| Runtime slice | `konoha-qa.slice` |
| Agent cap | `MemoryMax=900M`, `CPUQuota=150%` |
| Default MCP allowlist | `konoha` only |
| TestBench | Hinata only, on demand through bounded `konoha-testbench.service` |

The pool state is stored in `/opt/shared/konoha-sdd-worker-pool/state.json` by
default. State-changing commands take an advisory lock on the adjacent
`.lock` file, so concurrent starts are serialized before lifecycle API calls
and state writes. Expired missions are removed by `status` or `reap`.

## Commands

Start a bounded specialist mission:

```bash
python3 scripts/sdd-worker-pool.py start guy \
  --mission issue-123-mechanical-docs \
  --requester kakashi \
  --reason "mechanical docs update"
```

Stop one mission:

```bash
python3 scripts/sdd-worker-pool.py stop guy \
  --mission issue-123-mechanical-docs \
  --requester kakashi \
  --reason "mission complete"
```

Inspect or reap:

```bash
python3 scripts/sdd-worker-pool.py status
python3 scripts/sdd-worker-pool.py reap
```

Rollback all active pool workers:

```bash
python3 scripts/sdd-worker-pool.py rollback --reason "operator rollback"
```

Every start/stop sends a Konoha bus message with `SDD_POOL_START` or
`SDD_POOL_STOP`, making handoffs auditable. The script then calls the existing
`POST /agents/{id}/start` or `POST /agents/{id}/stop` lifecycle API. Use
`--dry-run` to inspect actions without calling the API or writing state.

## Handoff Rules

| From | To | Allowed when |
| --- | --- | --- |
| Kakashi | Guy | Mechanical batch, scaffold, or template work only |
| Shikadai | Shino | Reviewer requests QA/regression planning |
| Shino | Hinata | Test plan and test cases already exist |
| Shikadai | Ibiki | Security-sensitive review scope |

The ordinary GitHub issue flow must not add Shino, Hinata, Guy, or Ibiki unless
one of those rules is explicitly met. The Reviewer may run tests directly; using
specialists is an escalation, not a default stage.
