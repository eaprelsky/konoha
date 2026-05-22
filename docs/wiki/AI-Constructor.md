# AI Constructor

The AI constructor turns an operator request into reviewed workflow changes.
The important rule is simple: a text response is not a saved process. A process
counts as saved or runnable only after durable server-side actions succeed.

## Flow

1. The operator asks the assistant to create or change a process.
2. The assistant response is normalized into proposed actions and observable
   receipts.
3. Durable mutations go through Action Spine actions such as role creation,
   workflow creation, validation, deployment, and case start.
4. Workflow validation checks graph structure, role readiness, triggers,
   adapters, documents, lifecycle state, and deployment readiness.
5. Deployment creates executable state and runtime side-effect receipts.
6. Starting a case creates runtime state and the first assigned work item.

## Durable vs Preview

Konoha distinguishes preview edits from durable commits. Preview-only canvas
changes are useful while designing, but they are not treated as saved runtime
state. The backend committed workflow remains the source of truth after a
successful durable action.

## Acceptance Evidence

The golden path is covered by deterministic assistant, backend, and browser
tests in the repository. The public summary is:

- assistant fixture without a live LLM;
- backend create -> validate -> deploy -> run path;
- browser flow through AssistantWidget and ProcessEditor;
- negative tests for invalid and non-executable workflows.

See `docs/golden-path-acceptance-closure-report.md` in the repository for the
reviewed release-gate details.
