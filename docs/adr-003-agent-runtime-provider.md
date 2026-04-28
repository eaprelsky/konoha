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

### Profile Fields

AgentDef expresses the runtime profile through:

| Field | Purpose | Example |
|-------|---------|---------|
| `runtime` | Active runtime | `"claude"` |
| `fallback_runtime` | Fallback if primary fails | `"codex"` |
| `model` | Model identifier | `"claude:opus"` |
| `reasoning_effort` | Provider-specific effort level | `"high"` |

### Runtime Switching

`POST /agents/:id/switch-runtime` accepts `runtime`, `model`, `reasoning_effort`, `fallback_runtime` and updates the agent definition. If `restart: true`, the agent is restarted with the new profile. No SSH/tmux manual intervention required.

## Consequences

- Kakashi operates on `claude:opus` (DeepSeek V4) as the approved coding runtime for workflow-engine repair
- Codex remains configured as fallback; activation is gated on network/auth resolution (tracked in #555)
- Provider resolution path: `.agent-env` → `claude-provider.sh` → `apply-claude-profile.sh` → `agent-api-service.sh`
- Runtime boundaries are inspectable via `GET /agents/:id` and `scripts/healthcheck-system.py`
