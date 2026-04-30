---
name: Safe merge / cleanup gate
about: Request operator review for a delegated branch before merge or cleanup
title: "merge gate: <branch>"
labels: ["merge:review-required"]
---

## Branch

- Branch:
- Base:
- HEAD:
- Related issue:

## Checks

- `git diff --check`:
- targeted tests:
- typecheck:

## Changed files

-

## Risks/questions

-

## Requested operation

- [ ] review only
- [ ] rebase/conflict report
- [ ] local integration branch
- [ ] merge after `merge:ready`
- [ ] cleanup after `merged` or `merge:discarded`

No push to `main` is authorized by this template alone.
