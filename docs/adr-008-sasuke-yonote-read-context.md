# ADR-008: Sasuke Yonote Read Context

> Issue: #775 | Priority: P1 | Date: 2026-05-20 | Author: Kakashi
> Status: Proposed for review

## Context

Sasuke owns the Telegram user-account connector path. It may need corporate
knowledge context from Yonote to answer or route conversations, but adding the
whole corporate-memory surface to always-on Sasuke would undo the lean-runtime
MCP work.

The current production-critical Sasuke MCP set is:

- `konoha`
- `telethon-channel`
- `bitrix24`

Yonote is low-cost compared with browser or reasoning MCPs, but it is still an
extra local process pair and belongs to the `corporate-memory` experimental
feature flag.

## Decision

Sasuke does not get Yonote by default.

Yonote is approved only as a bounded task/session read-context overlay through
the repo-owned `yonote-read` MCP server:

- `KONOHA_MCP_SESSION_PACKS=yonote-read`
- feature flag `corporate-memory` enabled with an explicit reason
- allowlist/profile overlay `telegram-userbot-yonote-read`
- read/search-only usage; no raw Yonote RPC, document write/delete/export,
  collection write/delete, attachment create/upload/delete, admin, or bulk
  export tools through Sasuke
- idle timeout `900s`
- per-request context cap: at most 3 documents / 6000 chars / 60000 ms timeout

Persistent Sasuke startup continues to include only the production chat/CRM
surface. If Yonote is unavailable, disabled, missing from the shared MCP
catalog, or times out, Sasuke must continue user-account listening and CRM
routing without Yonote context.

The machine-readable policy is
`docs/sasuke-yonote-context-policy.json`.

## Measurement

Live sample on 2026-05-20 22:53 MSK:

```bash
ps -eo pid=,ppid=,rss=,pcpu=comm=,args= | awk 'BEGIN{IGNORECASE=1} /yonote-mcp|yonote/ && !/awk/ {print}'
```

Observed Yonote descendants were under stale Kiba broad MCP config, not Sasuke:

| Owner | Process count | RSS KiB | CPU |
| --- | ---: | ---: | ---: |
| Stale Kiba Yonote MCP | 2 | 24,156 | 0.0% |
| Sasuke persistent default delta | 0 | 0 | 0.0% |
| Sasuke task/session Yonote delta | 2 | 24,156 | 0.0% |

This keeps the always-on connector budget unchanged while allowing a
time-boxed knowledge lookup when an operator explicitly enables it.

## Fallback

Fallback behavior is intentionally boring:

- keep `telegram:incoming/sasuke` and `telegram:reaction_updates/sasuke-reactions`
  delivery active;
- keep `telethon-channel` and `bitrix24` available;
- answer without Yonote context or ask for clarification;
- do not restart, stop, or delay `agent-watchdog-sasuke.service` because Yonote
  is unavailable.

The contract test builds Sasuke startup with `yonote-read` in the allowlist and
proves that persistent startup still resolves only `konoha`,
`telethon-channel`, and `bitrix24` when Yonote is disabled/deferred. It also
checks that the full `yonote` MCP and raw/write/delete/export tool names are
not part of the Sasuke read-context surface.

## Rollback

Rollback is immediate because Yonote is not persistent startup:

```bash
unset KONOHA_MCP_SESSION_PACKS
# or remove yonote-read from KONOHA_MCP_SESSION_PACKS, then rebuild the session config
```

If a task/session has already started a Yonote read MCP wrapper, let the idle
timeout expire or stop the `konoha-mcp-yonote_read` scope. Do not change
Sasuke's default role allowlist or Redis consumer groups during rollback.
