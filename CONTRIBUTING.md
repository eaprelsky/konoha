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
