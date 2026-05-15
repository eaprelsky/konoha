#!/usr/bin/env bash
# Check that MCP config files use ${VAR} references, not raw secrets.
# refs: #768
set -euo pipefail

SEARCH_ROOTS=(
  /opt/shared/agent-workdirs
  /home/ubuntu/.mcp.json
  /home/ubuntu/.codex
  /home/ubuntu/telethon-mcp
  /opt/shared/comind-template/.mcp.json
)

usage() {
  cat <<'EOF'
Usage: check-mcp-secrets.sh [-h|--help]

  Scan all MCP config files for embedded raw secrets.
  Exit 0 if clean, exit 1 if raw secrets found.

EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage ;;
    *) echo "Unknown flag: $1"; exit 2 ;;
  esac
  shift
done

# Pattern: env var names that MUST use ${VAR} references, not raw values.
# Matches "KEY": "value" where value is a raw secret (not starting with ${).
read -r -d '' SECRET_PATTERN <<'PATTERN' || true
"(KONOHA_TOKEN|KONOHA_MIRAI_TOKEN|KONOHA_SHINO_TOKEN|TRACKER_TOKEN|TRACKER_CLOUD_ORG_ID|GITLAB_PERSONAL_ACCESS_TOKEN|YONOTE_API_KEY|CALDAV_USERNAME|CALDAV_PASSWORD|OPENROUTER_API_KEY|MIRO_API_TOKEN|BITRIX24_WEBHOOK_URL|CHATBOT_BITRIX_WEBHOOK)"\s*:\s*"(?!\$\{)[^"]{8,}"
PATTERN

VIOLATIONS=0
while IFS=: read -r file line text; do
  [ -z "$file" ] && continue
  echo "SECRET: $file:$line $text"
  VIOLATIONS=$((VIOLATIONS + 1))
done < <(grep -rnP "$SECRET_PATTERN" "${SEARCH_ROOTS[@]}" --include='*.json' 2>/dev/null | grep -v '.git/' | grep -v 'node_modules' || true)

echo ""
if [ "$VIOLATIONS" -eq 0 ]; then
  echo "OK: All MCP configs use \${VAR} references"
  exit 0
else
  echo "FAIL: $VIOLATIONS raw secret(s) found in MCP configs"
  exit 1
fi
