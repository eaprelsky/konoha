#!/usr/bin/env bash
# Migrate open GitHub issues from legacy labels to canonical taxonomy.
# Reads legacy→canonical map (pipe-delimited: "legacy|canonical"),
# applies replacements per-issue, removes legacy labels, and validates guardrails.
# Usage: ./scripts/gh-labels-migrate.sh [--dry-run]
# refs: docs/label-taxonomy.md, #793

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  shift
fi

# ── Migration map (legacy|canonical) ─────────────────────────────────────
# Pipe-delimited so labels with spaces (e.g. "P0: critical") parse correctly.
# Empty canonical means REMOVE only.
MIGRATIONS=(
  # Priority
  "P0|priority:p0"
  "P0: critical|priority:p0"
  "P1|priority:p1"
  "P1: high|priority:p1"
  "P2|priority:p2"
  "P2: medium|priority:p2"
  "P3|priority:p3"
  "P3: low|priority:p3"
  # State
  "delegate:done|state:done"
  "kakashi-ready|state:ready-for-dev"
  "awaiting-test|state:ready-for-test"
  '"awaiting-test"|state:ready-for-test'
  "needs-testing|state:ready-for-test"
  "blocked|state:blocked"
  # Agent
  "delegate:architect|agent:shikadai"
  # Type
  "bug|type:bug"
  "feature|type:feature"
  "enhancement|type:enhancement"
  "refactor|type:refactor"
  "architecture|type:architecture"
  "tech-debt|type:tech-debt"
  "security|type:security"
  "documentation|type:docs"
  "smoke|type:test"
  "test-failure|type:bug"
  # Area
  "backend|area:backend"
  "frontend|area:frontend"
  "messenger|area:messenger"
  "mcp|area:mcp"
  "action-spine|area:action-spine"
  "testbench|area:testbench"
  "devops|area:devops"
  "monitoring|area:devops"
  "i18n|area:i18n"
  # Risk
  "critical|risk:critical"
  "regression|risk:regression"
  # Remove-only (no replacement)
  "delegate:teamlead|"
  "kakashi-batch|"
  "test-cases-written|"
  "workflow|"
)

# ── Guardrails ───────────────────────────────────────────────────────────
# Labels that must be unique within their category
declare -A CATEGORY_RULES
CATEGORY_RULES[priority]="priority:p0 priority:p1 priority:p2 priority:p3"
CATEGORY_RULES[state]="state:triage state:ready-for-dev state:in-progress state:ready-for-review state:ready-for-test state:blocked state:done"

MANDATORY_CATEGORIES=("priority" "state")

CONFLICT_PAIRS=(
  "state:ready-for-dev state:ready-for-review"
  "state:done state:triage"
  "state:done state:ready-for-dev"
  "state:done state:in-progress"
  "state:done state:ready-for-review"
  "state:done state:ready-for-test"
  "state:done state:blocked"
)

check_guardrails() {
  local issue="$1"
  local labels="$2"
  local violations=()

  # Check mandatory: must have at least one label from each mandatory category
  for cat in "${MANDATORY_CATEGORIES[@]}"; do
    local found=false
    for canonical in ${CATEGORY_RULES[$cat]}; do
      if echo "$labels" | grep -qF "$canonical"; then
        found=true
        break
      fi
    done
    if ! $found; then
      violations+=("missing: no $cat label (must have one of: ${CATEGORY_RULES[$cat]})")
    fi
  done

  # Check mutual exclusivity within category
  for cat in priority state; do
    local found=()
    for canonical in ${CATEGORY_RULES[$cat]}; do
      if echo "$labels" | grep -qF "$canonical"; then
        found+=("$canonical")
      fi
    done
    if [[ ${#found[@]} -gt 1 ]]; then
      violations+=("$cat: multiple labels (${found[*]})")
    fi
  done

  # Check conflict pairs
  for pair in "${CONFLICT_PAIRS[@]}"; do
    local a="${pair%% *}"
    local b="${pair##* }"
    if echo "$labels" | grep -qF "$a" && echo "$labels" | grep -qF "$b"; then
      violations+=("conflict: $a + $b")
    fi
  done

  if [[ ${#violations[@]} -gt 0 ]]; then
    echo "  ⚠ Guardrail violations on $issue:"
    for v in "${violations[@]}"; do
      echo "    - $v"
    done
    return 1
  fi
  return 0
}

# ── Main ─────────────────────────────────────────────────────────────────
echo "=== Konoha label migration ==="
if $DRY_RUN; then
  echo "DRY RUN — no changes will be made"
fi
echo ""

# Get all open issues (excluding PRs)
ISSUES=$(gh issue list --limit 200 --json number,labels --jq '.[] | "\(.number) \(.labels | map(.name) | join(","))"' 2>/dev/null)
if [[ -z "$ISSUES" ]]; then
  echo "No open issues found."
  exit 0
fi

MIGRATED=0
SKIPPED=0
VIOLATIONS=0

while IFS=' ' read -r number labels_str; do
  [[ -z "$number" ]] && continue
  IFS=',' read -ra CURRENT <<< "$labels_str"

  ADD_LABELS=()
  REMOVE_LABELS=()

  # Build add/remove lists from migration map
  for current_label in "${CURRENT[@]}"; do
    current_label="${current_label//\"/}"   # strip quotes
    current_label="${current_label//\'/}"   # strip single quotes
    for mapping in "${MIGRATIONS[@]}"; do
      legacy="${mapping%%|*}"
      canonical="${mapping#*|}"
      legacy_clean="${legacy//\"/}"
      legacy_clean="${legacy_clean//\'/}"
      if [[ "$current_label" == "$legacy_clean" ]]; then
        REMOVE_LABELS+=("$current_label")
        if [[ -n "$canonical" ]]; then
          ADD_LABELS+=("$canonical")
        fi
        break
      fi
    done
  done

  if [[ ${#ADD_LABELS[@]} -eq 0 && ${#REMOVE_LABELS[@]} -eq 0 ]]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Dedup add list
  ADD_DEDUP=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && ADD_DEDUP+=("$line")
  done < <(printf '%s\n' "${ADD_LABELS[@]}" | sort -u)

  echo "#$number"
  echo "  current: ${CURRENT[*]}"
  echo "  remove:  ${REMOVE_LABELS[*]:-(none)}"
  echo "  add:     ${ADD_DEDUP[*]:-(none)}"

  # New label set for guardrail check
  NEW_SET=()
  for l in "${CURRENT[@]}"; do
    skip=false
    for r in "${REMOVE_LABELS[@]}"; do
      [[ "$l" == "$r" ]] && skip=true && break
    done
    $skip && continue
    NEW_SET+=("$l")
  done
  for a in "${ADD_DEDUP[@]}"; do
    NEW_SET+=("$a")
  done

  NEW_STR=$(printf '%s,' "${NEW_SET[@]}")
  if ! check_guardrails "#$number" "$NEW_STR"; then
    VIOLATIONS=$((VIOLATIONS + 1))
    if ! $DRY_RUN; then
      echo "  → SKIPPED due to guardrail violations"
      continue
    fi
  fi

  if $DRY_RUN; then
    echo "  [dry-run] would apply"
    MIGRATED=$((MIGRATED + 1))
    continue
  fi

  # Build gh issue edit command with arrays (safe for labels with spaces)
  EDIT_ARGS=("$number")
  for r in "${REMOVE_LABELS[@]}"; do
    EDIT_ARGS+=("--remove-label" "$r")
  done
  for a in "${ADD_DEDUP[@]}"; do
    EDIT_ARGS+=("--add-label" "$a")
  done

  gh issue edit "${EDIT_ARGS[@]}" 2>/dev/null || true
  echo "  → migrated"
  MIGRATED=$((MIGRATED + 1))

done <<< "$ISSUES"

echo ""
echo "=== Migration summary ==="
echo "  migrated:   $MIGRATED"
echo "  skipped:    $SKIPPED (no legacy labels)"
echo "  violations: $VIOLATIONS (guardrail-blocked)"
if $DRY_RUN; then
  echo "  (dry run — no changes applied)"
fi
echo ""
echo "Next: review migrated issues, then retire legacy labels:"
echo "  gh label delete 'P0' --yes"
echo "  gh label delete 'P0: critical' --yes"
echo "  gh label delete 'P1' --yes"
echo "  gh label delete 'P1: high' --yes"
echo "  gh label delete 'P2' --yes"
echo "  gh label delete 'P2: medium' --yes"
echo "  gh label delete 'P3' --yes"
echo "  gh label delete 'P3: low' --yes"
echo "  gh label delete 'delegate:teamlead' --yes"
echo "  gh label delete 'delegate:done' --yes"
echo "  gh label delete 'delegate:architect' --yes"
echo "  gh label delete 'kakashi-ready' --yes"
echo "  gh label delete 'kakashi-batch' --yes"
echo "  gh label delete 'awaiting-test' --yes"
echo "  gh label delete '\"awaiting-test\"' --yes"
echo "  gh label delete 'needs-testing' --yes"
echo "  gh label delete 'test-cases-written' --yes"
echo "  gh label delete 'workflow' --yes"
