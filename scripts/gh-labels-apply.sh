#!/usr/bin/env bash
# Create/update canonical GitHub labels for Konoha delivery workflow.
# Idempotent — uses 'gh label create' which fails on duplicate, so we
# 'gh label edit' as fallback.
# Usage: ./scripts/gh-labels-apply.sh [--dry-run]
# refs: docs/label-taxonomy.md, #793

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  shift
fi

# label name, color, description
create_or_update() {
  local name="$1"
  local color="$2"
  local desc="$3"

  if $DRY_RUN; then
    echo "[dry-run] gh label create '$name' --color '$color' --description '$desc'"
    return
  fi

  if gh label create "$name" --color "$color" --description "$desc" 2>/dev/null; then
    echo "  created $name"
  else
    # Already exists — update description/color
    gh label edit "$name" --color "$color" --description "$desc" 2>/dev/null || true
    echo "  updated $name"
  fi
}

# ── Priority ───────────────────────────────────────────────────────────
echo "=== Priority ==="
create_or_update "priority:p0" "b60205" "Blocking — fix/deliver immediately"
create_or_update "priority:p1" "e4312b" "Important — take next"
create_or_update "priority:p2" "fbca04" "Normal backlog"
create_or_update "priority:p3" "0e8a16" "Nice to have — do last"

# ── Workflow state ─────────────────────────────────────────────────────
echo "=== State ==="
create_or_update "state:triage"       "ededed" "New — needs classification"
create_or_update "state:ready-for-dev" "0052cc" "Spec complete — Kakashi can implement"
create_or_update "state:in-progress"   "1d76db" "Implementation active"
create_or_update "state:ready-for-review" "5319e7" "Code complete — Shikadai reviews"
create_or_update "state:ready-for-test" "0075ca" "Optional specialist QA branch requested by Reviewer"
create_or_update "state:blocked"       "d93f0b" "Cannot proceed — see blocked:* for reason"
create_or_update "state:done"          "0e8a16" "Delivered / closed"

# ── Component area ─────────────────────────────────────────────────────
echo "=== Area ==="
create_or_update "area:backend"     "0052cc" "Server, API, Redis, Postgres"
create_or_update "area:frontend"    "1d76db" "Dashboard, UI"
create_or_update "area:messenger"   "1d76db" "Telegram connectors, chat routing"
create_or_update "area:mcp"         "ededed" "MCP server, tool contracts"
create_or_update "area:action-spine" "0e8a16" "/act endpoint, action registry"
create_or_update "area:testbench"   "5319e7" "Test infrastructure, evals"
create_or_update "area:devops"      "5319e7" "Deploy, tmux, watchdog, monitoring"
create_or_update "area:docs"        "0075ca" "Documentation, runbooks"
create_or_update "area:i18n"        "c5def5" "Internationalisation / localisation"

# ── Work type ──────────────────────────────────────────────────────────
echo "=== Type ==="
create_or_update "type:bug"          "d73a4a" "Something is broken"
create_or_update "type:feature"      "a2eeef" "New capability"
create_or_update "type:enhancement"  "a2eeef" "Improve existing capability"
create_or_update "type:refactor"     "ededed" "Restructure without behaviour change"
create_or_update "type:tech-debt"    "fbca04" "Deferred cleanup / modernization"
create_or_update "type:architecture" "5319e7" "Cross-cutting design / system structure"
create_or_update "type:security"     "b60205" "Security-related work"
create_or_update "type:docs"         "0075ca" "Documentation only"
create_or_update "type:test"         "0e8a16" "Test coverage / test infra"

# ── Risk ───────────────────────────────────────────────────────────────
echo "=== Risk ==="
create_or_update "risk:critical"  "b60205" "Critical bug — potential data loss or outage"
create_or_update "risk:regression" "e11d48" "Previously working behaviour broken"

# ── Workflow route ──────────────────────────────────────────────────────
echo "=== Route ==="
create_or_update "route:architecture-decomposition" "5319e7" "Architecture decomposition workflow route"

# ── Agent assignment ───────────────────────────────────────────────────
echo "=== Agent ==="
create_or_update "agent:kakashi"  "ededed" "Developer — implementation"
create_or_update "agent:shikadai" "5319e7" "Reviewer — architecture / code review"
create_or_update "agent:hinata"   "0075ca" "Optional QA executor — explicit reviewer/test request only"
create_or_update "agent:shino"    "0e8a16" "Optional QA specialist — explicit reviewer request only"
create_or_update "agent:naruto"   "d93f0b" "Exception handler / intake, not ordinary dispatcher"

# ── Blocker reason ─────────────────────────────────────────────────────
echo "=== Blocker ==="
create_or_update "blocked:external"    "d93f0b" "Waiting on external system / API / person"
create_or_update "blocked:dependency"  "d93f0b" "Blocked by another Konoha issue"
create_or_update "blocked:needs-info"  "d93f0b" "Needs clarification before proceeding"

echo "=== Done ==="
echo "Canonical labels applied. Legacy labels can now be migrated."
echo "Next: ./scripts/gh-labels-migrate.sh [--dry-run]"
