#!/usr/bin/env bash
set -euo pipefail

ROOT="${KONOHA_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export PATH="/home/ubuntu/.bun/bin:$PATH"

run_step() {
  local name="$1"
  shift
  echo
  echo "== $name =="
  "$@"
}

run_backend_tests() {
  (
  cd "$ROOT"
  bun test --timeout 30000 \
    tests/assistant-response.test.ts \
    tests/redis.test.ts \
    tests/operator-state.test.ts \
    tests/akamaru_paused.test.ts \
    tests/akamaru.test.ts \
    tests/issue77_paused_names.test.ts \
    tests/applyPatch.test.ts \
    tests/act-workflow-executor.test.ts \
    tests/eepc-state-machine-regression.test.ts \
    tests/cases_unit.test.ts \
    tests/kwe_email_adapter.test.ts \
    tests/ai-chat-contract.test.ts \
    tests/operator-evals.test.ts \
    tests/workflow-action-contract.test.ts \
    tests/assistant-autonomy-evals.test.ts
  )
}

run_frontend() {
  (
  cd "$ROOT/frontend"
  bun x tsc --noEmit
  bun run test
  bun run build
  )
}

cd "$ROOT"
run_step "backend typecheck" bun x tsc --noEmit
run_step "backend tests" run_backend_tests
run_step "frontend typecheck/test/build" run_frontend
run_step "legacy enforcement" bash -c '! grep -r "/tsunade/chat\|/ai/process-chat" src/routes/ --include="*.ts" --include="*.tsx"'
run_step "action coverage" bun run scripts/action-coverage.ts

echo
echo "portable preflight OK"
