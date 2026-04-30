# GitHub Issue Events For SDD

Issue #639 defines the first normalized GitHub issue event shape for future SDD
workflows. This does not replace the watchdog scanner yet; the current
`delegate:teamlead` and `delegate:architect` label delivery remain intact.

## Normalized Events

The source id is `github`. Workflows should use message triggers with
`source: "github"` and filter by `event`.

| Event | GitHub source | Purpose |
|---|---|---|
| `issue_labeled` | `issues.labeled` | Start delegated work from labels such as `delegate:teamlead` or `delegate:architect`. |
| `issue_comment` | `issue_comment.created/edited` | Feed operator comments into an active case. |
| `branch_ready` | `pull_request.opened/reopened/synchronize/ready_for_review` | Signal that an implementation branch exists. |
| `checks_passed` | successful `check_suite.completed` or `check_run.completed` | Signal that required checks are green. |
| `review_requested` | `pull_request.review_requested` | Signal review handoff. |

The TypeScript contract is in `src/github-issue-events.ts`.

## Delegation Migration

Current behavior:

1. An operator adds `delegate:teamlead` to an implementation batch issue or `delegate:architect` to an architecture-decomposition issue.
2. The watchdog sees the label and injects the task into Kakashi.
3. Child issues report progress with `delegate:done` or `blocked`.

Future workflow trigger:

```json
{
  "kind": "message",
  "source": "github",
  "filter": {
    "event": "issue_labeled",
    "label": "delegate:teamlead"
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
