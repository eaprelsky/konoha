# Frontend i18n Copy Rules

Product UI copy in `frontend/src` belongs in `frontend/src/i18n/translations.ts` and should be read through `useI18n().t(...)`.

Runtime and organization-specific names do not belong in the static dictionary. Keep agent aliases, process names, role names, document content, customer-specific labels, and other tenant data in runtime/org data sources such as the display catalog or API payloads.

## Guard

Run:

```bash
PATH=/home/ubuntu/.bun/bin:$PATH bun run i18n:guard
```

The guard scans a scoped set of operator/demo TypeScript/TSX files for Cyrillic literals outside intentional locations such as `frontend/src/i18n/translations.ts` and frontend tests. It intentionally does not keep a repository-wide legacy allowlist; older hardcoded copy outside the scoped files remains migration debt and should be moved incrementally.

When migrating a string:

1. Add English and Russian entries to `frontend/src/i18n/translations.ts`.
2. Replace the hardcoded literal with `const { t } = useI18n();` and `t('key')`.
3. Run `bun run i18n:guard` before committing.

Do not add new hardcoded product copy in guarded files. Runtime data such as agent aliases, process names, role names, and document content should stay in API/runtime data sources rather than the static dictionary.
