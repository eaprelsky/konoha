# Browser Testing Policy

Issue #778 makes TestBench the default GUI verification path for agents. Issue
#758 keeps that path on demand and bounded instead of always-on.

## Default Path

- Browser checks should use the bounded on-demand `konoha-testbench.service` on
  port 3203.
- Agent access to TestBench is via the Konoha MCP `testbench` skill, which adds
  `konoha_testbench_*` tools to the existing Konoha MCP server.
- Hinata, the QA executor, is seeded with the `testbench` capability so QA
  workflows can run browser checks without starting per-agent browser MCP
  infrastructure.

## Lifecycle Modes

| Mode | Profiles | Operator contract |
| --- | --- | --- |
| Disabled | `prod-core`, `staging-core`, `ci-test` | Do not run `konoha-testbench.service`; browser routes and MCP tools stay hidden unless the `testbench` feature is explicitly enabled. |
| On demand | `qa-on-demand`, CI/golden-path jobs | Start `konoha-testbench.service` only for the browser check window with `TESTBENCH_POOL_SIZE=1`, `TESTBENCH_MAX_POOL_SIZE=2`, `TESTBENCH_MAX_CONCURRENT_JOBS=2`, and `TESTBENCH_SESSION_TTL_MS=300000`. |
| Persistent debug | Production operator debugging only | Keep a single-session pool only while capacity allows and the `testbench` feature is explicitly enabled; stop the service after the debug window. |

Runbook:

```bash
KONOHA_SERVICE_PROFILE=qa-on-demand KONOHA_ENABLED_FEATURES=testbench sudo systemctl start konoha-testbench.service
python3 scripts/healthcheck-system.py | rg 'testbench.pool|resource_inventory'
sudo systemctl stop konoha-testbench.service
```

`GET /testbench/status` exposes `mode`, `total`, `free`, `busy`, `waiting`, and
the configured pool/request/TTL limits for admin diagnostics.

## Direct Browser MCP

Direct browser MCP servers such as `puppeteer` are not part of always-on or
monitoring-only agent defaults. They are allowed only through the explicit
`browser-debug-ttl` tool profile for time-boxed QA/debug sessions with an
operator-approved TTL and resource limit.

Other heavy collaboration MCPs, including Office, Miro, Google Docs, and
spreadsheet packs, follow `docs/mcp-optional-packs-policy.md`.

Do not assign `full`, `browser-debug-ttl`, `puppeteer`, `playwright`, or
`browser` shared MCP access to Naruto, Sasuke, Kiba, Kakashi, or other
monitoring/connector agents by default.

## Enforcement

- `src/agent/tool-profiles.ts` keeps `diagnostics` scoped to Konoha-only shared
  access; it no longer expands to every shared MCP server.
- `tests/tool-profiles.test.ts` prevents browser MCP servers from appearing in
  non-debug profiles.
- `tests/system-agent-classification.test.ts` prevents always-on non-QA seeded
  agents from using browser MCP or TestBench by default, and confirms Hinata uses
  TestBench for QA browser checks.
