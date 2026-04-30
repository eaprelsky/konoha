# Message Router Evals

`src/message-router-evals.ts` defines an offline harness for cheap routing
experiments before Sasuke or any production messenger router calls an LLM.

Routing labels:

- `ignore`
- `human_notify`
- `sales_workflow`
- `ops_task`
- `knowledge_intake`
- `dev_workflow`
- `unknown_escalate`

Fixtures are synthetic Telegram-like histories only. They include short noise,
ops incidents, dev requests, knowledge intake, ambiguous routing, and a
long-context sales case with more than 20 messages.

The scorer checks two things:

1. predicted routing label matches the expected label;
2. classifier cited all required context message refs.

Future cheap classifiers should implement `MessageRouterClassifier` and can be
evaluated with `runMessageRouterEval()` without reading private chats or calling
external providers in the baseline test suite.
