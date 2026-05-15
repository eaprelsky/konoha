#!/usr/bin/env bash
# Comprehensive MCP config secret validation.
# Checks: raw secrets (key-value + loose surfaces), ${VAR} resolution.
# refs: #768
set -euo pipefail

SEARCH_ROOTS=(
  /opt/shared/agent-workdirs
  /home/ubuntu/.mcp.json
  /home/ubuntu/.codex
  /home/ubuntu/telethon-mcp
  /opt/shared/comind-template/.mcp.json
  /opt/shared/comind-template/.claude
)

# Directories / files to exclude from all scans
EXCLUDE_DIRS=('.git' 'node_modules' '.venv' '__pycache__')
EXCLUDE_FILES=('auth.json' 'plugin.lock.json')

ENV_FILE="${ENV_FILE:-/home/ubuntu/.agent-env}"
VIOLATIONS=0
MODE="full"

# MCP secret env var names that MUST be defined in .agent-env
REQUIRED_ENV_VARS=(
  KONOHA_TOKEN KONOHA_MIRAI_TOKEN KONOHA_SHINO_TOKEN
  TRACKER_TOKEN TRACKER_CLOUD_ORG_ID
  GITLAB_PERSONAL_ACCESS_TOKEN
  YONOTE_API_KEY
  CALDAV_USERNAME CALDAV_PASSWORD
  OPENROUTER_API_KEY
  MIRO_API_TOKEN
  BITRIX24_WEBHOOK_URL CHATBOT_BITRIX_WEBHOOK
)

# Patterns that look like real API tokens / keys (not hashes, not UUIDs)
# tuned to avoid false positives on package-lock SHAs and plugin hashes
SECRET_VALUE_RE=(
  'sk-(ant-api03|or-v1)-[A-Za-z0-9_-]{20,}'
  'y0__[A-Za-z0-9_-]{30,}'
  'eyJ[A-Za-z0-9_/-]{30,}\.[A-Za-z0-9_/-]{10,}\.[A-Za-z0-9_/-]{10,}'
  'SrzTHFh9[A-Za-z0-9]{12,}'
)

usage() {
  cat <<'EOF'
Usage: check-mcp-secrets.sh [-h|--help] [--lite|--full]

  Scan MCP/config files for embedded raw secrets and missing env vars.
  --lite  Only validate KONOHA_TOKEN (for lite-profile agents).
  --full  Validate all known MCP secret vars (default).
  Exit 0 if clean, exit 1 if violations found.

EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage ;;
    --lite) MODE="lite" ;;
    --full) MODE="full" ;;
    *) echo "Unknown flag: $1"; exit 2 ;;
  esac
  shift
done

# Lite mode: only validate KONOHA_TOKEN
if [ "$MODE" = "lite" ]; then
  REQUIRED_ENV_VARS=(KONOHA_TOKEN)
fi

# ── Helpers ──────────────────────────────────────────────────────────────────

build_exclude_args() {
  local args=""
  for d in "${EXCLUDE_DIRS[@]}"; do
    args="$args --exclude-dir=$d"
  done
  echo "$args"
}

is_excluded_file() {
  local path="$1"
  local base
  base=$(basename "$path")
  for ef in "${EXCLUDE_FILES[@]}"; do
    [ "$base" = "$ef" ] && return 0
  done
  # Exclude anything under .tmp/
  [[ "$path" == */.tmp/* ]] && return 0
  return 1
}

is_secret_value() {
  local val="$1"
  for re in "${SECRET_VALUE_RE[@]}"; do
    [[ "$val" =~ ^${re}$ ]] && return 0
  done
  return 1
}

redact() {
  local val="$1" len=${#val}
  if [ "$len" -le 8 ]; then
    printf '%s' "${val:0:2}***"
  else
    printf '%s' "${val:0:4}***${val: -4}"
  fi
}

loaded_env_vars() {
  grep -oP '^[A-Z][A-Z0-9_]+(?==)' "$ENV_FILE" 2>/dev/null | sort -u || true
}

# Known JSON keys that must use ${VAR}
KNOWN_KEYS_RE="KONOHA_(TOKEN|MIRAI_TOKEN|SHINO_TOKEN)|TRACKER_(TOKEN|CLOUD_ORG_ID)|GITLAB_PERSONAL_ACCESS_TOKEN|YONOTE_API_KEY|CALDAV_(USERNAME|PASSWORD)|OPENROUTER_API_KEY|MIRO_API_TOKEN|BITRIX24_WEBHOOK_URL|CHATBOT_BITRIX_WEBHOOK"
# Lite mode: only check KONOHA_TOKEN key
if [ "$MODE" = "lite" ]; then
  KNOWN_KEYS_RE="KONOHA_TOKEN"
fi

EXCLUDE_ARGS=$(build_exclude_args)

# ── Check 1: raw secrets as JSON key-value pairs ────────────────────────────

check_json_secrets() {
  local file line key val redacted
  while IFS= read -r hit; do
    # hit format: file:line:text
    file="${hit%%:*}"
    local rest="${hit#*:}"
    line="${rest%%:*}"
    local text="${rest#*:}"

    is_excluded_file "$file" && continue

    key=$(echo "$text" | grep -oP '"\K[^"]+' | head -1 || true)
    val=$(echo "$text" | grep -oP '"[^"]*"\s*:\s*"\K[^"]+' | head -1 || true)

    [ -z "$val" ] && continue
    [[ "$val" == \$\{* ]] && continue
    # Skip only short/placeholder values (< 8 chars, or common placeholders)
    [ "${#val}" -lt 8 ] && continue
    [[ "$val" == "test" || "$val" == "null" || "$val" == "none" || "$val" == "placeholder" ]] && continue

    redacted=$(redact "$val")
    echo "SECRET: $file:$line  key=\"$key\"  value=$redacted"
    VIOLATIONS=$((VIOLATIONS + 1))
  done < <(
    grep -rn $EXCLUDE_ARGS \
      -P '"(('"$KNOWN_KEYS_RE"'))"\s*:\s*"(?!\$\{)[^"]{8,}"' \
      "${SEARCH_ROOTS[@]}" --include='*.json' 2>/dev/null || true
  )
}

# ── Check 2: loose secrets in any text context ──────────────────────────────

check_loose_secrets() {
  local file line val redacted
  for pat in "${SECRET_VALUE_RE[@]}"; do
    while IFS= read -r hit; do
      file="${hit%%:*}"
      local rest="${hit#*:}"
      line="${rest%%:*}"
      local text="${rest#*:}"

      is_excluded_file "$file" && continue
      # Skip package-lock.json
      [[ "$file" == *package-lock.json* ]] && continue
      # Skip if immediately after "${"  (i.e. inside ${VAR})
      [[ "$text" =~ \$\{[A-Z_]+\} ]] && continue

      val=$(echo "$text" | grep -oP "$pat" | head -1 || true)
      [ -z "$val" ] && continue

      redacted=$(redact "$val")
      echo "SECRET: $file:$line  loose-secret=$redacted"
      VIOLATIONS=$((VIOLATIONS + 1))
    done < <(
      grep -rn $EXCLUDE_ARGS -P "$pat" \
        "${SEARCH_ROOTS[@]}" --include='*.json' 2>/dev/null || true
    )
  done
}

# ── Check 3: required env vars referenced in configs must exist in .agent-env

check_missing_env() {
  local defined var
  defined=$(loaded_env_vars)

  for var in "${REQUIRED_ENV_VARS[@]}"; do
    if ! echo "$defined" | grep -qxF "$var"; then
      # Find which files reference this missing var
      local files
      files=$(grep -rl $EXCLUDE_ARGS "\${$var}" \
        "${SEARCH_ROOTS[@]}" --include='*.json' 2>/dev/null | paste -sd, - || true)
      echo "MISSING_ENV: \${$var} referenced but not defined in $ENV_FILE  (files: ${files:-none})"
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done
}

# ── Run ──────────────────────────────────────────────────────────────────────
echo "=== check-mcp-secrets.sh (#768) [mode: $MODE] ==="
echo "Roots: ${SEARCH_ROOTS[*]}"
echo "Env:   $ENV_FILE"
echo ""

echo "--- Check 1: JSON key-value secrets ---"
check_json_secrets

echo ""
echo "--- Check 2: Loose secrets in any surface ---"
check_loose_secrets

echo ""
echo "--- Check 3: Required \${VAR} references resolve ---"
check_missing_env

echo ""
if [ "$VIOLATIONS" -eq 0 ]; then
  echo "OK: No violations found"
  exit 0
else
  echo "FAIL: $VIOLATIONS violation(s) found"
  exit 1
fi
