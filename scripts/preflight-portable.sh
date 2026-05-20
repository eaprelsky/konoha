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
    tests/test-storage-guardrails.test.ts \
    tests/test-factory-namespace.test.ts \
    tests/redis-test-isolation-contract.test.ts \
    tests/pg-test-isolation-contract.test.ts \
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
    tests/assistant-autonomy-evals.test.ts \
    tests/bpms-load-regression.test.ts \
    tests/data-store-drill.test.ts \
    tests/mail-integration-profile.test.ts
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

run_bpms_load_report() {
  (
  cd "$ROOT"
  local profile="${BPMS_LOAD_PROFILE:-ci-bpms-regression}"
  local observations="${BPMS_LOAD_OBSERVATIONS:-tests/fixtures/bpms-load/ci-passing.json}"
  local report="${BPMS_LOAD_REPORT:-/tmp/bpms-load-regression-report.json}"
  bun run scripts/bpms-load-regression.ts --profile "$profile" --observations "$observations" --report "$report"
  )
}

run_data_store_drill_report() {
  (
  cd "$ROOT"
  local observations="${DATA_STORE_DRILL_OBSERVATIONS:-tests/fixtures/data-store-drill/staging-passing.json}"
  local report="${DATA_STORE_DRILL_REPORT:-/tmp/konoha-data-store-drill-report.json}"
  bun run scripts/data-store-drill.ts --observations "$observations" --report "$report"
  )
}

cd "$ROOT"
run_step "backend typecheck" bun x tsc --noEmit
run_step "backend tests" run_backend_tests
run_step "frontend typecheck/test/build" run_frontend
run_step "legacy enforcement" bash -c '! grep -r "/tsunade/chat\|/ai/process-chat" src/routes/ --include="*.ts" --include="*.tsx"'
run_step "action coverage" bun run scripts/action-coverage.ts
run_step "BPMS load profile contract" bun run scripts/bpms-load-regression.ts --check
run_step "BPMS load regression report" run_bpms_load_report
run_step "data-store drill contract" bun run scripts/data-store-drill.ts --check
run_step "data-store drill report" run_data_store_drill_report
run_step "mail integration profile" bun run scripts/mail-integration-profile.ts

echo
echo "portable preflight OK"
