# Safe merge and cleanup protocol

This protocol lets a delegated worker prepare branches for operator review without autonomous pushes to `main`.

## States

| State | Meaning | Allowed next state |
| --- | --- | --- |
| `delegated` | Work has been assigned but no branch result exists yet. | `in_progress`, `discarded` |
| `in_progress` | Worker is editing or testing a local branch. | `local_commit_ready`, `blocked`, `discarded` |
| `local_commit_ready` | Local commit exists, no push has happened. | `review_required` |
| `review_required` | Operator or reviewer must inspect report, diff, and checks. | `merge_ready`, `discarded`, `in_progress` |
| `merge_ready` | Reviewer explicitly approves integration. | `merged`, `discarded` |
| `merged` | Human/operator gate merged and pushed. | cleanup |
| `discarded` | Branch result is intentionally abandoned. | cleanup |

Suggested labels:

- `delegate:teamlead`: batch/delegation entrypoint.
- `delegate:done`: child issue completed with local commit report.
- `merge:review-required`: local branch needs review.
- `merge:ready`: reviewer approved merge.
- `merge:discarded`: branch intentionally dropped.

## Allowed Worker Operations

Kakashi may:

- create a branch from `origin/main`;
- make bounded local commits;
- run tests/typechecks/smoke commands;
- rebase a delegated branch onto current `origin/main` when asked;
- attempt a local merge into a temporary integration branch when asked;
- report conflicts without resolving beyond the requested scope;
- delete local scratch branches after the operator confirms cleanup.

Kakashi must not:

- push to `main`;
- enable auto-push;
- rewrite another worker's branch without explicit instruction;
- delete remote branches;
- mark `merge:ready` without reviewer approval.

## Merge Report

Use `scripts/merge-readiness-report.ts` to generate the reusable comment body:

```bash
bun run scripts/merge-readiness-report.ts --base origin/main --checks "bun x tsc --noEmit: pass"
```

The report includes branch, base, HEAD commit, ahead/behind counts, changed files, check summary, and residual risks. It is read-only and refuses to run on `main`.

## Checklist

1. Confirm `git status --short --branch` is clean except the intended branch work.
2. Confirm the branch starts from current `origin/main` or report rebase/conflicts.
3. Run targeted tests plus any package-level typecheck required by touched files.
4. Generate a merge readiness report.
5. Comment the child issue with the report and add `delegate:done`.
6. Operator reviews and decides `merge:ready` or `merge:discarded`.
7. Only after the gate, perform merge/push or cleanup.

## Cleanup

Cleanup is allowed only after `merged` or `discarded` is explicit. Local cleanup may delete local scratch branches and temporary files created for the merge report. Remote cleanup requires operator instruction.
