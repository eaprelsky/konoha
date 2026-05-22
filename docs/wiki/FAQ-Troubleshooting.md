# FAQ / Troubleshooting

## Is The Wiki The Source Of Truth?

No. The source pages live in `docs/wiki/` in the main repository. The GitHub
Wiki is generated from reviewed repository content.

## Can I Edit The GitHub Wiki Directly?

No. Direct Wiki edits will be overwritten by the sync process. Open a normal
repository change against `docs/wiki/` instead.

## Why Did My Workflow Not Run?

Common reasons:

- the workflow is not executable yet;
- validation found graph, role, trigger, adapter, document, or lifecycle
  blockers;
- deployment side effects failed;
- the first work item could not be dispatched.

Use validation receipts, deploy receipts, runtime effects, and monitor views to
find the exact blocker.

## Why Is A Connector Disabled?

Some connectors are optional or environment-specific. Local, CI, and staging
profiles intentionally avoid production connector credentials and external
side effects unless explicitly approved.

## Why Are There PostgreSQL Rows That Are Not In Redis?

PostgreSQL may contain shadow or historical records. Redis remains the active
runtime store until staged read gates are accepted. Redis-only records are a
release blocker; PostgreSQL-only retention bloat is handled by retention
policy.

## Where Are Private Agent Instructions?

They are intentionally not in the public Wiki. Private agent instructions,
runtime memory, classification dumps, tokens, production paths, and raw
operational logs are excluded by policy and by the sync checks.
