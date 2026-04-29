# ADR-003: Agent Runtime & Provider Architecture

**Status:** Accepted  
**Date:** 2026-04-28  
**Deciders:** Kakashi, Naruto  

## Context

Konoha managed agents must be able to switch between LLM providers and runtimes without manual tmux/SSH intervention. The system supports multiple providers: Claude API (via Anthropic SDK), DeepSeek V4 (via OpenAI-compatible adapter), GLM, and Codex CLI (OpenAI GPT-native).

After platform hardening (#543 epic), the workflow engine will be delegated to an autonomous coding agent. The runtime/provider path must be explicitly documented and tested.

## Decision

### Primary Runtime: `claude` via DeepSeek V4 provider

The managed agent fleet runs on the `claude` runtime with provider resolution through `/home/ubuntu/.agent-env` and `scripts/claude-provider.sh`. The active provider is **DeepSeek V4**, served through an OpenAI-compatible adapter with Claude-compatible settings.

**Rationale:**
- DeepSeek V4 is the stable default for persistent Telegram-facing agents because it is reachable directly and does not depend on the Codex proxy path
- DeepSeek V4 provides equivalent coding capability without geo-restriction
- Provider wrapper supports hot-switching to GLM as additional Anthropic-compatible fallback

### Fallback Runtime: `codex` via GPT-5.5

Codex CLI is the designated fallback runtime and is configured in AgentDef (`fallback_runtime: "codex"`). It will be activated when either:
1. The active LLM client profile is explicitly switched to `codex-gpt-5.5`
2. Automatic runtime fallback selects `fallback_llm_client_profile: "codex-gpt-5.5"`

As of 2026-04-29 the server has a working opt-in proxy chain for Codex/OpenAI traffic:

- `sing-box` SOCKS on `127.0.0.1:1080`
- `privoxy` HTTP(S) proxy on `127.0.0.1:8118`
- proxy env exported by `/home/ubuntu/.agent-env`
- corporate VLESS+Reality upstream tagged `corporate-vless` in `/etc/sing-box/config.json`

`/home/ubuntu/.npm-global/bin/codex` is on `codex-cli 0.125.0`. The verification command in `docs/codex-vpn-runbook.md` returns `codex-vpn-ok` with `--model gpt-5.5`, and `scripts/healthcheck-system.py` reports `OK llm_profiles.codex_fallback`.

### Profile Fields

AgentDef is migrating from ambiguous `runtime`/`model` pairs to explicit LLM client profiles. During migration, both forms are supported.

Preferred fields:

| Field | Purpose | Example |
|-------|---------|---------|
| `llm_client_profile` | Runtime adapter + provider + model profile | `"claude-deepseek-opus"` |
| `fallback_llm_client_profile` | Fallback LLM client profile | `"codex-gpt-5.5"` |

Legacy compatibility fields:

| Field | Purpose | Example |
|-------|---------|---------|
| `runtime` | Active runtime | `"claude"` |
| `fallback_runtime` | Fallback if primary fails | `"codex"` |
| `model` | Model identifier | `"claude:opus"` |
| `reasoning_effort` | Provider-specific effort level | `"high"` |

The key distinction is that `claude` means the Claude Code CLI adapter, not Anthropic as a provider. The active Kakashi profile is `claude-deepseek-opus`: Claude Code CLI over the DeepSeek Anthropic-compatible endpoint, resolving to `deepseek-v4-pro`.

### Runtime Switching

`POST /agents/:id/switch-runtime` accepts `llm_client_profile`, `fallback_llm_client_profile`, `runtime`, `model`, `reasoning_effort`, and `fallback_runtime`, then updates the agent definition. If `restart: true`, the agent is restarted with the new profile. No SSH/tmux manual intervention required.

`GET /agents/llm-client-profiles` exposes the available client profiles for admin UI, healthcheck, and operator diagnostics.

## Consequences

- Kakashi operates on `claude:opus` (DeepSeek V4) as the approved coding runtime for workflow-engine repair
- Codex is an enabled fallback profile, but the default persistent fleet remains on Claude/DeepSeek unless an operator switches runtime profiles
- Provider resolution path: `.agent-env` → `claude-provider.sh` → `apply-claude-profile.sh` → `agent-api-service.sh`
- Runtime boundaries are inspectable via `GET /agents/:id` and `scripts/healthcheck-system.py`
