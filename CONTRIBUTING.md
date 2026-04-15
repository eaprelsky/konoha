# Contributing to Konoha

## Getting started

```bash
git clone https://github.com/eaprelsky/konoha
cd konoha
bun install
```

## Development

```bash
# Start backend
bun run src/server.ts

# Start frontend (dev mode)
cd frontend && bun run dev
```

See `docs/testing.md` for running tests.

## Code style

- TypeScript everywhere (no `any` unless unavoidable)
- Bun as runtime and package manager
- Hono for backend routes
- React + Vite for frontend
- Commits in English, imperative mood: `fix: ...`, `feat: ...`, `docs: ...`, `refactor: ...`

## Pull request process

1. Branch from `main`: `git checkout -b fix/your-description`
2. One commit per logical change
3. All tests must pass: `bun test && npx playwright test`
4. PR title: short imperative sentence (≤70 chars)
5. Reference the GitHub issue: `closes #N` in commit message

## Governance for Tsunade / operator work

If your change touches any of the following:

- Tsunade or assistant runtime
- action contracts or envelopes
- confirmations, permissions, or operator-visible results
- agent-readable state or operator flows

then you must read:

- `docs/governance/ai-native-operator-constitution.md`
- `docs/adr-002-tsunade-materialization.md`

For these changes, "it works" is not sufficient. Reviewers may reject a PR if it introduces a parallel contract, preserves legacy divergence as a target state, or weakens the canonical action/state/confirmation model.

## Issue labels

| Label | Meaning |
|-------|---------|
| `P0: critical` | Production broken — fix immediately |
| `P1: high` | Important bug or feature |
| `P2: medium` | Normal backlog |
| `P3: low` | Nice to have |
| `bug` | Something is broken |
| `enhancement` | Improvement to existing feature |
| `documentation` | Docs only |
| `awaiting-test` | Fix committed, regression test pending |

## Architecture notes

- See `docs/ports.md` for service port assignments
- See `docs/adapters.md` for external service integrations
- See `docs/testing.md` for test architecture and E2E auth
- See `docs/governance/ai-native-operator-constitution.md` for the governing document on the Tsunade operator line
