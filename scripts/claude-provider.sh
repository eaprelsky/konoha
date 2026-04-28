#!/bin/bash

set -euo pipefail

konoha_claude_profile_upper() {
    printf '%s' "${1}" | tr '[:lower:]-' '[:upper:]_'
}

konoha_claude_profile_var() {
    local profile_upper
    profile_upper="$(konoha_claude_profile_upper "$1")"
    printf 'KONOHA_CLAUDE_%s_%s' "$profile_upper" "$2"
}

konoha_claude_require_var() {
    local name="$1"
    if [ -z "${!name:-}" ]; then
        echo "Missing required Claude provider variable: $name" >&2
        return 1
    fi
}

konoha_append_no_proxy_host() {
    local host="$1"
    local current="${2:-}"
    case ",${current}," in
        *",${host},"*)
            printf '%s' "$current"
            ;;
        "")
            printf '%s' "$host"
            ;;
        *)
            printf '%s,%s' "$current" "$host"
            ;;
    esac
}

konoha_claude_active_profile() {
    printf '%s' "${KONOHA_CLAUDE_PROVIDER_PROFILE:-deepseek}"
}

konoha_claude_profile_model() {
    local profile="${1}"
    local slot="${2}"
    local var_name
    var_name="$(konoha_claude_profile_var "$profile" "${slot}_MODEL")"
    konoha_claude_require_var "$var_name" >/dev/null
    printf '%s' "${!var_name}"
}

konoha_claude_resolve_model() {
    local requested="${1:-sonnet}"
    local profile="${2:-$(konoha_claude_active_profile)}"
    case "$requested" in
        ""|auto|sonnet|claude-sonnet-4-6|glm-5.1)
            konoha_claude_profile_model "$profile" "SONNET"
            ;;
        haiku|claude-haiku-4-5-20251001|glm-4.5-air|flash)
            konoha_claude_profile_model "$profile" "HAIKU"
            ;;
        opus|claude-opus-4-6)
            konoha_claude_profile_model "$profile" "OPUS"
            ;;
        *)
            printf '%s' "$requested"
            ;;
    esac
}

konoha_export_claude_provider_env() {
    local profile="${1:-$(konoha_claude_active_profile)}"
    local base_var auth_var subagent_var
    base_var="$(konoha_claude_profile_var "$profile" "BASE_URL")"
    auth_var="$(konoha_claude_profile_var "$profile" "AUTH_TOKEN")"
    subagent_var="$(konoha_claude_profile_var "$profile" "SUBAGENT_MODEL")"

    konoha_claude_require_var "$base_var"
    konoha_claude_require_var "$auth_var"

    export ANTHROPIC_BASE_URL="${!base_var}"
    export ANTHROPIC_AUTH_TOKEN="${!auth_var}"
    export ANTHROPIC_API_KEY="${!auth_var}"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="$(konoha_claude_profile_model "$profile" "HAIKU")"
    export ANTHROPIC_DEFAULT_SONNET_MODEL="$(konoha_claude_profile_model "$profile" "SONNET")"
    export ANTHROPIC_DEFAULT_OPUS_MODEL="$(konoha_claude_profile_model "$profile" "OPUS")"
    export CLAUDE_CODE_SUBAGENT_MODEL="${!subagent_var:-$(konoha_claude_profile_model "$profile" "SONNET")}"
    export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${KONOHA_CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"
    export CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK="${KONOHA_CLAUDE_DISABLE_NONSTREAMING_FALLBACK:-1}"
    export CLAUDE_CODE_EFFORT_LEVEL="${KONOHA_CLAUDE_EFFORT_LEVEL:-max}"
    export API_TIMEOUT_MS="${KONOHA_CLAUDE_API_TIMEOUT_MS:-3000000}"
    export no_proxy="$(konoha_append_no_proxy_host "api.deepseek.com" "${no_proxy:-}")"
    export no_proxy="$(konoha_append_no_proxy_host "api.z.ai" "${no_proxy}")"
    export NO_PROXY="$(konoha_append_no_proxy_host "api.deepseek.com" "${NO_PROXY:-}")"
    export NO_PROXY="$(konoha_append_no_proxy_host "api.z.ai" "${NO_PROXY}")"
}

konoha_write_claude_settings() {
    local target="${1:-$HOME/.claude/settings.json}"
    local profile="${2:-$(konoha_claude_active_profile)}"
    mkdir -p "$(dirname "$target")"
    konoha_export_claude_provider_env "$profile"
    python3 - "$target" <<'PY'
import json
import os
import sys

target = sys.argv[1]
payload = {
    "env": {
        "ANTHROPIC_AUTH_TOKEN": os.environ["ANTHROPIC_AUTH_TOKEN"],
        "ANTHROPIC_API_KEY": os.environ["ANTHROPIC_API_KEY"],
        "ANTHROPIC_BASE_URL": os.environ["ANTHROPIC_BASE_URL"],
        "ANTHROPIC_DEFAULT_SONNET_MODEL": os.environ["ANTHROPIC_DEFAULT_SONNET_MODEL"],
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": os.environ["ANTHROPIC_DEFAULT_HAIKU_MODEL"],
        "ANTHROPIC_DEFAULT_OPUS_MODEL": os.environ["ANTHROPIC_DEFAULT_OPUS_MODEL"],
        "CLAUDE_CODE_SUBAGENT_MODEL": os.environ["CLAUDE_CODE_SUBAGENT_MODEL"],
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": os.environ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"],
        "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK": os.environ["CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK"],
        "CLAUDE_CODE_EFFORT_LEVEL": os.environ["CLAUDE_CODE_EFFORT_LEVEL"],
        "API_TIMEOUT_MS": os.environ["API_TIMEOUT_MS"],
    },
    "skipDangerousModePermissionPrompt": True,
}
with open(target, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY
}
