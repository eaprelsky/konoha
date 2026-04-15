# AI-Native Operator Constitution

> Governing document for the Tsunade operator line: `#525`, `#526`, `#527`, `#528`, `#529`, `#530`, `#531`, `#532`, `#533`, `#534`

## Purpose

This document exists because the issue set is strong as a roadmap, but not yet sufficient as a fully self-contained executable specification for external contributors.

Use this constitution as the primary decision frame for any change that touches Tsunade, operator flows, action contracts, assistant runtime, confirmations, or agent-readable state.

If an implementation "works" but violates this document, it is not converged.

## Canonical target architecture

Konoha must evolve from a human-first UI with assistant add-ons into an AI-native operator platform where Tsunade is a first-class operator of the system.

That means:

- one canonical action model across UI, backend API, MCP, and assistant flows;
- one canonical assistant runtime and entrypoint for operator interactions;
- server-side normalization of model output into explicit actions and results;
- an agent-readable state surface instead of raw UI/DOM interpretation;
- explicit permissions, confirmations, and observable results for meaningful actions.

## Five pillars

Every relevant change should strengthen at least one of these pillars and must not weaken any of them:

1. `State` — the system exposes canonical, readable, durable state.
2. `Affordances` — the system makes available actions discoverable and explicit.
3. `Permissions` — the system encodes what may happen automatically vs what requires approval.
4. `Confirmations` — risky actions have explicit confirmation semantics.
5. `Observable Result` — every meaningful action has a visible, auditable outcome.

## Non-negotiable invariants

The following are mandatory for any converged solution in this line:

1. No raw LLM transport in the user-facing contract.
   Model output may be used internally, but frontend behavior must not depend on raw JSON/text parsing from the model.

2. No parallel mutation contracts.
   UI, API, MCP, and assistant flows must converge on one canonical action vocabulary and envelope.

3. No legacy path as a valid long-term target.
   Transitional paths are acceptable only with explicit removal scope and a clear convergence plan.

4. No hidden architectural divergence.
   Equivalent operations must not keep separate semantics just because they enter through different surfaces.

5. No silent side effects.
   Important actions must produce explicit confirmations, receipts, or state changes that can be observed and verified.

6. No unformalized assumptions where a contract can exist.
   If a behavior matters, it should be encoded in types, schemas, envelopes, checklists, or tests.

## Forbidden compromises

The following should be treated as architectural regressions, even if they unblock short-term delivery:

- introducing another assistant-specific request or response contract beside the canonical one;
- keeping legacy panel behavior alive without a retirement plan;
- adding a frontend-only interpretation layer for model output as the real source of truth;
- letting UI, API, and MCP describe the same operation with different action semantics;
- solving a systemic problem with an undocumented adapter that preserves the old divergence;
- shipping a temporary path with no owner, no removal trigger, and no convergence criteria.

## Required sequence

Changes in this line should respect this order unless an explicit decision packet says otherwise:

1. Diagnose the break and name the target shape.
   Reference: `#525`, `#526`, `docs/adr-002-tsunade-materialization.md`

2. Stop raw transport leakage and normalize server-side.
   Reference: `#528`

3. Collapse divergent assistant entrypoints into one runtime.
   Reference: `#529`

4. Canonicalize the action spine across surfaces.
   Reference: `#527`

5. Extend the platform around the spine.
   References: `#530`, `#531`, `#532`, `#533`, `#534`

## Convergence test

A change is considered converged only if the answer is "yes" to all of these:

- Does it move the system closer to one canonical assistant runtime?
- Does it reduce, rather than hide, architectural divergence?
- Does it strengthen the canonical action/state/confirmation model?
- Does it improve at least one of the five pillars without weakening the others?
- Can a human operator and an agent operator rely on the same operational contract?
- Is the result durable enough to survive new flows and 10x system scale?

If the answer is "no" or "not yet" to any item, the change is transitional at best and must be labeled and planned as such.

## Canonical examples

Use these patterns as reference:

### Good: assistant workflow creation

- Assistant request enters through the canonical runtime.
- Server normalizes intent into canonical action(s).
- Server executes workflow creation.
- Frontend receives structured result, not model transport.
- UI shows explicit created draft/result and navigates consistently.

### Good: operator-visible mutation

- Mutation is represented by a canonical action ID.
- Autonomy/confirmation policy is explicit.
- Post-action state and receipt are visible.
- The same operation can be triggered by UI, MCP, or assistant without semantic drift.

### Bad: hidden divergence

- Legacy panel keeps its own response shape.
- Assistant flow depends on client-side JSON parsing.
- API and MCP wrap the same mutation through different semantics.
- "Temporary" adapter becomes the real contract.

## How to use this document

- Link this document from every issue and PR in the Tsunade operator line.
- Treat it as a review gate, not a passive wiki page.
- Reject changes that violate it, even if they appear locally correct.
- Update it only when the target architecture changes, not for routine implementation detail.
