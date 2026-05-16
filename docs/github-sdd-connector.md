# GitHub Issue Events For SDD

Issue #639 defines the first normalized GitHub issue event shape for SDD
workflows. The active default delivery lane is the two-role Developer ->
Reviewer process: Kakashi implements and Shikadai reviews/accepts.

## Normalized Events

The source id is `github`. Workflows should use message triggers with
`source: "github"` and filter by `event`.

| Event | GitHub source | Purpose |
|---|---|---|
| `issue_labeled` | `issues.labeled` | Start delegated work from canonical labels such as `state:ready-for-dev` + `agent:kakashi` or `state:ready-for-review` + `agent:shikadai`. |
| `issue_comment` | `issue_comment.created/edited` | Feed operator comments into an active case. |
| `branch_ready` | `pull_request.opened/reopened/synchronize/ready_for_review` | Signal that an implementation branch exists. |
| `checks_passed` | successful `check_suite.completed` or `check_run.completed` | Signal that required checks are green. |
| `review_requested` | `pull_request.review_requested` | Signal review handoff. |

The TypeScript contract is in `src/github-issue-events.ts`.

## Delegation Migration

Current behavior:

1. An issue becomes `state:ready-for-dev` + `agent:kakashi` when it is ready for implementation.
2. The Kakashi watchdog sees the canonical labels and injects exactly that issue into Kakashi.
3. Kakashi pushes the implementation and moves/hands off the issue to `state:ready-for-review` + `agent:shikadai`.
4. Shikadai reviews architecture, code, and required tests, then accepts, requests changes, or blocks. Closure happens only after reviewer acceptance.

Future workflow trigger:

```json
{
  "kind": "message",
  "source": "github",
  "filter": {
    "event": "issue_labeled",
    "required_labels": ["state:ready-for-dev", "agent:kakashi"]
  }
}
```

The normalized event payload includes `repo`, `issue_number`, `issue_title`,
`issue_url`, `sender`, `labels`, and event-specific fields such as `label`,
`comment`, `branch`, `check`, or `review_request`.

## Boundaries

- The webhook route still verifies `GITHUB_WEBHOOK_SECRET` when configured.
- No GitHub PAT or live webhook secret is required for the normalizer tests.
- The adapter is additive: it dispatches normalized events to Event Manager
  listeners, while keeping the existing Redis stream and watchdog path.
- This slice does not implement auto-merge or replace the watchdog scanner.
- `kakashi-batch` is not part of the #794 bootstrap flow.
- Retired delegation labels, `awaiting-test`, and `needs-testing` are legacy labels. Ordinary
  work must not route through Shino/Hinata/Guy by default; Reviewer-requested
  specialist work is an explicit branch outside the default Developer ->
  Reviewer path.
