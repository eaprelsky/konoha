# Assistant Permissions And Confirmations

Issue: `#532`

## Purpose

Assistant-driven mutations must respect the same explicit permission and confirmation model across:

- canonical action discovery
- `/act` envelope execution
- assistant response normalization paths such as workflow materialization

No assistant path may silently bypass confirmation requirements.

## Canonical semantics

- `auto`: assistant may execute immediately
- `confirm`: assistant may propose the action, but execution must stop and produce a pending confirmation object
- `disabled`: assistant must not execute the action

## Permission scope

Current scope model:

- actor scope: `assistant_on_behalf_of_user`
- permission source: canonical action id + autonomy matrix
- confirmation source: canonical action policy, not prompt text

This means the assistant inherits only the scoped autonomy configured for the canonical action, not blanket user trust.

## Confirmation contract

When a confirm-required action is requested through assistant normalization:

- the action is recorded in audit as `requires_confirm`
- the action result is returned as `needs_confirm`
- the response includes `pending_confirmations[]`
- no side effect is executed before confirmation

## Current coverage

- `workflow.create` in assistant normalization now respects the same confirm-required semantics as the canonical action model
- assistant issue creation uses canonical action id `issue.create`

This closes the confirmation bypass where workflow creation could previously materialize through the assistant normalization path without going through explicit permission semantics.
