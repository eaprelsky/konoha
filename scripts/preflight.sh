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

run_frontend() {
  (
  cd "$ROOT/frontend"
  bun x tsc --noEmit
  bun run build
  )
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
    tests/mcp-action-bridge.test.ts \
    tests/eepc-state-machine-regression.test.ts \
    tests/cases_unit.test.ts \
    tests/kwe_email_adapter.test.ts \
    tests/ai-chat-contract.test.ts \
    tests/operator-evals.test.ts \
    tests/workflow-action-contract.test.ts \
    tests/assistant-autonomy-evals.test.ts
  )
}

cd "$ROOT"
run_step "system health" python3 scripts/healthcheck-system.py
run_step "backend typecheck" bun x tsc --noEmit
run_step "action surface contract" bun run scripts/action-surface-report.ts --check
run_step "backend tests" run_backend_tests
run_step "frontend typecheck/build" run_frontend

if [[ "${SKIP_TELEGRAM_SMOKE:-0}" == "1" ]]; then
  echo
  echo "== telegram smoke =="
  echo "skipped because SKIP_TELEGRAM_SMOKE=1"
else
  run_step "telegram smoke" scripts/telegram-smoke.sh
fi

run_step "postgres shadow verification" bun run scripts/pg-verify.ts

echo
echo "preflight OK"
