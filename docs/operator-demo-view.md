# Operator Demo View

Issue #636 inventory found visible demo noise in the main operator surfaces:

- Workflows: many old `e2e-*`, `tc-*`, `test-*`, copied, generated draft, and mobile assistant/editor workflows.
- Runs: repeated runs for copied/generated workflows, including `process-*-copy` cases.
- Roles: legacy test roles such as `tester`, `qa`, and `reviewer`.
- Monitoring: event and subscription rows tied to hidden generated workflows.

The UI now defaults to an operator view that hides records marked as non-operator artifacts.
Debug/admin access is still available from the per-page "Служебные" checkbox or by
opening the page with `?view=debug`.

## Metadata Contract

Prefer explicit metadata on new records instead of relying on generated ids:

```json
{
  "metadata": {
    "visibility": "test",
    "source": "testbench",
    "tags": ["generated"],
    "operator_visible": false
  }
}
```

Hidden values are `debug`, `internal`, `test`, `generated`, and `deprecated`.
`metadata.operator_visible=false` also hides the record. `metadata.visibility=operator`
or `metadata.audience=["operator"]` keeps a record visible.

Legacy untagged artifacts are still filtered by stable generated ids and copy markers
so the existing demo surface is clean before a data backfill exists.
