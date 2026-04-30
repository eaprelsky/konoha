# Action Spine CLI spike

The CLI spike reuses the same registry and envelope validation as API and MCP.

```bash
bun run scripts/action-spine-cli.ts workflow.list '{}'
bun run scripts/action-spine-cli.ts workflow.create '{"elements":[],"flow":[],"draft":true}' --dry-run
```

Mutating actions are blocked unless `--dry-run` or `--execute-write` is explicit. The intended safe smoke for write contracts is `--dry-run`; it validates the action ID and JSON args without writing runtime state.

This is not a polished CLI. It is a bridge proving that CLI invocation can share the Action Spine contract instead of defining separate command schemas.
