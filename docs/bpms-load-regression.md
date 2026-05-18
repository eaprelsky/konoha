# BPMS Load Regression Suite

Issue #788 adds a reproducible gate for high-volume Workflow Engine traffic.
The machine-readable profile catalog is `docs/bpms-load-profiles.json`; the
threshold evaluator is `scripts/bpms-load-regression.ts`.

## Profiles

| Profile | Budget | Duration | Purpose |
| --- | --- | --- | --- |
| `ci-bpms-regression` | `ci-test` | 120 seconds | Portable regression fixture for preflight and CI. |
| `release-gate-staging` | `staging-core` | 30 minutes | Short staging release gate before broad BPMS changes. |
| `staging-soak-8h` | `staging-core` | 8 hours | Soak run for sustained event and process-instance traffic. |

Every profile covers process instances, Telegram activation chains, Redis
stream messages, outbox retry attempts, retention cycles, UI compaction window
limits, Redis command-rate ceilings, and memory growth ceilings.

## Commands

Validate the profile catalog:

```bash
bun run scripts/bpms-load-regression.ts --check
```

Generate the portable release-gate report from an observation file:

```bash
bun run scripts/bpms-load-regression.ts \
  --profile ci-bpms-regression \
  --observations tests/fixtures/bpms-load/ci-passing.json \
  --report /tmp/bpms-load-regression-report.json
```

For staging soak, run the load generator against `staging-core`, collect the
same observation shape, then evaluate it with:

```bash
bun run scripts/bpms-load-regression.ts \
  --profile staging-soak-8h \
  --observations /tmp/staging-soak-observations.json \
  --report /tmp/bpms-load-regression-report.json
```

Attach `bpms-load-regression-report.json` to the release gate record. A failed
report blocks release until the offending Redis command rate, memory growth,
pending stream, outbox retry, retention, UI compaction, CPU, or RSS threshold is
back under the profile budget.

`scripts/preflight.sh` and `scripts/preflight-portable.sh` generate the report
automatically. Override the default portable fixture with:

```bash
BPMS_LOAD_PROFILE=staging-soak-8h \
BPMS_LOAD_OBSERVATIONS=/tmp/staging-soak-observations.json \
BPMS_LOAD_REPORT=/tmp/bpms-load-regression-report.json \
scripts/preflight.sh
```
