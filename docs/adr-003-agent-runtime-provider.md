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
- Codex CLI (`codex-cli 0.122.0`) is installed and configured but blocked by geo-restriction: `unsupported_country_region_territory` from OpenAI (server in Vienna/VIA)
- DeepSeek V4 provides equivalent coding capability without geo-restriction
- Provider wrapper supports hot-switching to GLM as additional fallback

### Fallback Runtime: `codex` (conditional)

Codex CLI is the designated fallback runtime and is configured in AgentDef (`fallback_runtime: "codex"`). It will be activated when either:
1. A supported network/auth path becomes available for the Vienna region
2. The server is migrated to a supported OpenAI region

As of 2026-04-28 the server has a local proxy chain (`sing-box` SOCKS on `127.0.0.1:1080`, `privoxy` HTTP proxy on `127.0.0.1:8118`), but its upstream credentials are not valid for Codex:

- `breakfast` fails Reality verification
- `vanya-ss` times out
- `aeza` accepts SOCKS connections but returns empty TCP/TLS responses

Therefore Codex must stay disabled until fresh proxy/VPN credentials are installed and `scripts/healthcheck-system.py` reports a healthy `codex_proxy.chatgpt` check.

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
- Codex remains configured as fallback; activation is gated on network/auth resolution (tracked in #555)
- Provider resolution path: `.agent-env` → `claude-provider.sh` → `apply-claude-profile.sh` → `agent-api-service.sh`
- Runtime boundaries are inspectable via `GET /agents/:id` and `scripts/healthcheck-system.py`
