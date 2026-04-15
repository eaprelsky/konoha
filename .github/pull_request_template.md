## Summary

Describe the change and the user-visible or operator-visible outcome.

## Issue

Link the issue this PR implements.

## Governance

If this PR touches Tsunade, assistant runtime, action contracts, confirmations, or operator flows, review:

- `docs/governance/ai-native-operator-constitution.md`
- `docs/adr-002-tsunade-materialization.md`

## Checklist

- [ ] I did not introduce a new parallel contract for UI/API/MCP/assistant.
- [ ] I did not leave a legacy path as the long-term target state.
- [ ] If this is transitional, the removal path is explicit in the PR description.
- [ ] This change strengthens at least one of the five pillars: State, Affordances, Permissions, Confirmations, Observable Result.
- [ ] Any important action now has clearer contracts, confirmations, or observable results.
- [ ] Frontend behavior does not depend on raw LLM transport as the source of truth.
- [ ] Tests or verification steps cover the intended canonical behavior.

## Verification

List tests, manual checks, or end-to-end scenarios you ran.
