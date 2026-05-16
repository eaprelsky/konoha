# System Agent Roster

Issue #790 makes this roster the canonical deployment contract for runtime ids,
AgentDef lifecycle metadata, systemd/tmux/watchdog compatibility surfaces,
healthcheck policy, and Akamaru/Kiba monitoring expectations.

Compatibility names are intentionally stable. Do not rename systemd units, tmux
sessions, Redis streams, or watchdog files as part of roster cleanup unless a
separate compatibility migration says to do so.

| Runtime id | Role | Lifecycle | Launch | Owner | MCP allowlist | Resource budget | systemd / tmux / watchdog | Kiba monitor | Paused semantics |
|------------|------|-----------|--------|-------|---------------|-----------------|---------------------------|--------------|------------------|
| `naruto` | Telegram bot connector | `connector_owned` | `persistent_interactive` | Telegram bot connector | none | `konoha-connectors.slice` | `agent-naruto.service` / `naruto` / `agent-watchdog-naruto.service` | default | Warn while Telegram connector is enabled. |
| `sasuke` | Telegram user-account connector | `connector_owned` | `persistent_interactive` | Telegram user connector | `telethon-channel`, `bitrix24` | `konoha-connectors.slice` | `agent-sasuke.service` / `sasuke` / `agent-watchdog-sasuke.service` | default | Warn while Telegram connector is enabled. |
| `akamaru` | Autonomous health monitor script | external infra | `systemd_service` | Kiba | none | `konoha-agents.slice` | `akamaru.service` / none / none | self | Pause only when health monitoring is intentionally disabled. |
| `kiba` | System monitor | `optional_on_demand` | `persistent_interactive` | Platform monitoring | none | `konoha-agents.slice`, `700M/900M`, CPU `150%` | `agent-kiba.service` / `kiba` / `agent-watchdog-kiba.service` | default | Warn while enabled by health policy. |
| `kakashi` | Developer in Developer -> Reviewer | `optional_on_demand` | `persistent_interactive` | SDD developer lane | none | `konoha-qa.slice`, `700M/900M`, CPU `150%` | `agent-kakashi.service` / `kakashi` / `agent-watchdog-kakashi.service` | default | Service/watchdog failures alert when active; missing tmux can be suppressed after on-demand mission completion. |
| `shikadai` | Reviewer / architecture-code review worker | `optional_on_demand` | `persistent_interactive` | SDD reviewer lane | none | `konoha-qa.slice` | `agent-managed@shikadai.service` / `shikadai` / `agent-watchdog-shikadai.service` | default | Reviewer watchdog requires `state:ready-for-review` + `agent:shikadai`; decomposition uses `route:architecture-decomposition`; missing tmux can be suppressed after review completion. |
| `mirai` | External-source connector compatibility actor | `connector_owned` | `persistent_interactive` | External-source connector | none | `konoha-qa.slice` via `agent-managed@.service` | `agent-managed@mirai.service` / `mirai` / `agent-watchdog-lifecycle.service` | on demand | Missing tmux is expected when not enabled or idle. |
| `shino` | Optional QA lead | `optional_on_demand` | `persistent_interactive` | Reviewer-requested QA | none | `konoha-qa.slice` via `agent-managed@.service` | `agent-managed@shino.service` / `shino` / `agent-watchdog-lifecycle.service` | on demand | Missing tmux is expected unless reviewer activates QA. |
| `hinata` | Optional QA executor with TestBench browser checks | `optional_on_demand` | `persistent_interactive` | Reviewer-requested QA | none | `konoha-qa.slice` via `agent-managed@.service` | `agent-managed@hinata.service` / `hinata` / `agent-watchdog-lifecycle.service` | on demand | Missing tmux is expected unless reviewer activates QA. |
| `guy` | Optional mechanical developer helper | `optional_on_demand` | `persistent_interactive` | Kakashi explicit helper request | none | `konoha-qa.slice` via `agent-managed@.service` | `agent-managed@guy.service` / `guy` / `agent-watchdog-lifecycle.service` | on demand | Missing tmux is expected unless Kakashi activates the helper. |
| `ibiki` | Optional security auditor | `optional_on_demand` | `persistent_interactive` | Security escalation | none | `konoha-qa.slice` via `agent-managed@.service` | `agent-managed@ibiki.service` / `ibiki` / `agent-watchdog-lifecycle.service` | on demand | Missing tmux is expected unless security review is active. |
| `jiraiya` | Disabled corporate-memory experiment / deprecated compatibility alias | `deprecated` | `persistent_interactive` | Operator approval required | none | `konoha-qa.slice` only when temporarily enabled | `agent-managed@jiraiya.service` / `jiraiya` / none | suppressed | Keep parked unless the owner explicitly reactivates it; stale MCP configs must stay quarantined. |
| `ino` | Deprecated marketing-specialist compatibility alias | `deprecated` | `persistent_interactive` | Operator approval required | none | `konoha-qa.slice` only when temporarily enabled | `agent-managed@ino.service` / `ino` / `agent-watchdog-lifecycle.service` | suppressed | Keep parked unless the owner explicitly reactivates it. |
| `inojin` | Deprecated editor compatibility alias | `deprecated` | `persistent_interactive` | Operator approval required | none | `konoha-qa.slice` only when temporarily enabled | `agent-managed@inojin.service` / `inojin` / `agent-watchdog-lifecycle.service` | suppressed | Keep parked unless the owner explicitly reactivates it. |
| `itachi` | External remote operator on owner's machine | external | `manual_remote` | Owner machine | none | outside server budget | `agent-watchdog-itachi.service` / `itachi` / `agent-watchdog-itachi.service` | no | Server healthcheck does not alert on this runtime. |
| `shikamaru` | External owner advisor compatibility name | external | `manual_external` | Owner | none | outside server budget | none / none / none | no | Not a server-managed runtime. |
| `tsunade` | Product assistant core runtime | `core` | service | Platform | none | `konoha-core.slice` | `konoha.service` / `tsunade` / none | default | Pause only during explicit maintenance. |

## Runtime Policy

- Default Developer -> Reviewer flow is Kakashi as Developer, then Shikadai as
  Reviewer. Shino/Hinata/Guy/Ibiki are optional escalation workers only.
- `agent-watchdog-lifecycle.service` watches only lifecycle-managed optional or
  compatibility actors: Mirai, Shino, Hinata, Ibiki, Ino, Inojin, and Guy.
  Jiraiya is excluded because the corporate-memory experiment is disabled until
  an explicit product need and operator approval exist.
- Kakashi, Shikadai, Kiba, Naruto, and Sasuke have dedicated watchdogs because
  their delivery filters are role-specific.
- Kiba's default tool profile is `kiba-monitor-core`: Konoha health/action MCP
  only. GitLab, Yonote, Yandex Tracker, Miro, Office/document tools,
  browser/Puppeteer, memory/mempalace, spreadsheets, calendar,
  audio/transcription, and broad corporate operations MCPs are on-demand only.
- Deprecated aliases stay seeded only for compatibility. They should be parked
  by default and may be listed in `/opt/shared/kiba/paused-services.txt` when an
  operator intentionally suppresses expected inactivity.
