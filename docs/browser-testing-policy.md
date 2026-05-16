# Browser Testing Policy

Issue #778 makes TestBench the default GUI verification path for agents.

## Default Path

- Browser checks should use the bounded `konoha-testbench.service` on port 3203.
- Agent access to TestBench is via the Konoha MCP `testbench` skill, which adds
  `konoha_testbench_*` tools to the existing Konoha MCP server.
- Hinata, the QA executor, is seeded with the `testbench` capability so QA
  workflows can run browser checks without starting per-agent browser MCP
  infrastructure.

## Direct Browser MCP

Direct browser MCP servers such as `puppeteer` are not part of always-on or
monitoring-only agent defaults. They are allowed only through the explicit
`browser-debug-ttl` tool profile for time-boxed QA/debug sessions with an
operator-approved TTL and resource limit.

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
