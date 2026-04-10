# Changelog

All notable changes to Konoha are documented here.

---

## [1.4.0] — 2026-03-XX

### Added
- **Redis → PostgreSQL Phase 2 migration** (#332) — `PG_READ=true` switches all case/work-item reads to PostgreSQL; Redis continues as write-through cache.
- **Plugin architecture** — `core/` and `modules/` directory structure; `KonohaFrontendPlugin` interface for extending nav and routes from modules.
- **plugin-api.md** — plugin architecture documentation.
- **Token bucket rate limiter** (#335) — protects condition-polling loops in the event manager from runaway evaluation.
- **Unit tests for ProcessEditor hook** (#336) — 24 vitest tests covering addElement, deleteElement, updateElement, undo/redo, newProcess, and paletteClick.
- **/editor/:id route** (#328) — deep-link to open a specific process in the editor by URL.
- **/testbench/login** endpoint (#327) — allows TestBench sessions to authenticate programmatically.

### Changed
- **ProcessEditor.tsx decomposed** (#330) — 1773 → 482 lines. Extracted: `useProcessEditor.ts` (state/logic), `PropertiesPanel.tsx`, `ProcessTree.tsx`, `VersionSelector.tsx`, `RegistryPicker.tsx`, `TsunadeChatPanel.tsx`, `MiningOverlay.tsx`, `ArrowRouter.ts`, `ElementShape.tsx`.
- **runtime.ts decomposed** (#338) — 1532 → 17-line barrel. Logic split into `src/runtime/{cases,work-items,roles,documents,reminders,event-log}.ts`.
- **CSS extracted from components** (#334) — inline `style` props replaced with CSS classes in `ProcessEditor.css`.
- **Dead entry points removed** (#329) — unused webpack/vite entry files deleted from the build.
- **Strict TypeScript enabled** (#333) — `strict: true` in `frontend/tsconfig.json`; zero `tsc --noEmit` errors.

### Fixed
- **process.exception events** (#339/#340) — write-path sync bugs fixed; `process.exception` is now correctly emitted when a case enters error state.
- **HTTP 500 on empty POST /messages/{agent}/ack** (#341) — missing body guard added.

---

## [1.3.0] — 2026-02-XX

### Added
- **Inspector + AssistantWidget** (#293) — floating AI assistant panel with chat, network log, and console capture; unified `/ai/chat` SSE endpoint.
- **Run overlay on eEPC schema** (#296) — live case progress overlaid on the process diagram via SSE stream.
- **3-layer navigation redesign** (#295) — Processes / Team / Settings top-level sections; Setup Wizard for first-run onboarding.
- **White-labeling + Branding UI** (#298) — custom logo, colours, and assistant name per installation.
- **Visual regression testing + Self-Writing Loop** (#297) — Playwright screenshot comparison; CI pipeline can detect UI regressions automatically.
- **Attachment support in Tsunade chat** (#321) — screenshots, specs, and reference files can be sent to the AI assistant.
- **Assistant actions audit log** (#294) — all AI-initiated actions (issue creation, code execution) are logged with autonomy-level metadata; prompt injection protection added.

### Changed
- **TestBench** (#292) — persistent Chromium service for agent GUI testing; HighlightOverlay (#313), interactive Tour (#314), Tsunade action hooks (#315).
- **Composite agent prompt** (#290) — agents receive role-block prompts with skill contexts; hot-reload on change.
- **`core/` + `modules/` directory structure** (#304) — backend platform moved to `core/src/`; workflow engine to `modules/workflow-engine/`.

### Fixed
- **TG message replay on watchdog restart** (#318) — watchdog now re-delivers unprocessed messages after session restart.
- **Content-pattern filter in telegram-bot adapter** (#319) — `matchesFilter` now correctly applies `content_pattern`.
- **Subscription deduplication** (#319) — `createSubscriptionProgrammatic` deduplicates by `(event_id, instance_id)`.
- **Agent interrupt on L1 message > 30s** (#320) — watchdog aborts stuck agent sessions waiting on L1.
- **Auto-create skeleton role** (#312) — workflows referencing unknown roleIds get a skeleton role created automatically on index update.
- **HTTP 413** (#299) — messages exceeding 32 KB are rejected with a proper error response.

---

## [1.2.0] — 2025-12-XX

### Added
- **14 Process Tools (MCP)** (#291) — skill-gated MCP tools for case management, work-item completion, and workflow CRUD, available to agents with the `process-tools` capability.
- **Jiraiya corporate memory agent** (#234/#255/#262) — knowledge workflow + MemPalace wake-up context for cross-session memory.
- **Auto-wake on-demand agents** (#274) — agents (Shino, Hinata, Kiba) are automatically started when a message arrives and their tmux session is dead.
- **Bitrix monitor ported to event-manager** (#285) — replaces cron-based polling with a proper event-manager timer subscription.

### Changed
- **Named tmux sockets** — each agent uses `-L <id>` socket for process isolation, preventing cross-agent session collisions.
- **ProcessEditor.tsx split into 4 modules** (#289) — first decomposition pass: ArrowRouter, ElementShape, MiningOverlay, TsunadeChatPanel extracted.

### Fixed
- **PID liveness check in getAgentState** (#276) — dead `running` agents are auto-reset.
- **Watchdog paste-wait threshold** (#300) — threshold-based `paste_wait` prevents stuck paste on messages ~2 KB.
- **Missing elements/flow in validateWorkflow** (#301) — null-safe handling of empty workflow definitions.
- **Redis DB mismatch in tests** (#283/#284) — tests now run on DB 1; production uses DB 0.
- **`/health` for liveness, `/agents` for heartbeats** (#282) — Akamaru watchdog uses correct endpoints.

---

## [1.1.0] — 2025-11-XX

### Added
- **Telegram message processing workflow** (#256) — incoming Telegram messages trigger a Konoha workflow; Sasuke acts as a role-based executor.
- **Konoha lifecycle for all core agents** — Naruto (#259), Sasuke (#258), Kakashi (#257) ported to AgentDef + Konoha lifecycle watchdog.
- **GitHub webhook receiver** (#264) — incoming GitHub events (issue assignments) are routed to the appropriate agent.
- **Kakashi auto-picks next issue** (#263) — Kakashi reads the issue queue and self-assigns the next task on startup.
- **BullMQ reminder scheduler** (#232) — reminders migrated from polling to BullMQ delayed jobs for reliability.
- **Whitelist management UI** (#240) — trusted-user whitelist editable from the System settings page.

### Fixed
- **Gateway XOR display + role/executor separation** (#273) — systemic fix for XOR gateway rendering and role assignment logic.
- **Undo/redo, executor type, role shape** (#265–#268) — multiple ProcessEditor stability fixes.
- **Monitor event payload viewer, force-close stuck runs** (#269–#272) — Monitor UI fixes.
- **SSE Last-Event-ID replay** (#254) — stale connections are detected and re-connected with correct replay.
- **N+1 Redis queries** (#252) — `sendMessage`, `publishEvent`, `registerAgent` pipelined.

---

## [1.0.0] — 2025-10-XX

Initial release.

### Features
- **eEPC process editor** — drag-and-drop visual editor for event-driven process chains; elements: events, functions, gateways (AND/XOR/OR), documents, roles, information systems.
- **Case engine** — `createCase` / `advanceCase` / `completeWorkItem` lifecycle; parallel branches (AND/OR gateway); XOR conditional routing.
- **Work Items UI** — task inbox for human executors; Telegram notifications on assignment.
- **Agent lifecycle** — agent registry, heartbeat, start/stop/restart via API; tmux-based session management.
- **Event Monitor** — subscription management, event history, adapter status dashboard.
- **Konoha Bus** — inter-agent messaging over HTTP + Redis Streams SSE; MCP server for Claude Code integration.
- **Jiraiya knowledge agent** — corporate memory with Yonote/Tracker integration.
- **PostgreSQL shadow writes** — all Redis mutations are mirrored to PostgreSQL for durability.
- **SPA frontend** — React + Vite; client-side routing; code splitting.
- **WorkCalendar** — Russian RF 2026 business calendar; `P{N}BD` duration support.
- **Telegram adapters** — bot (Grammy/XREADGROUP) and user-account (Telethon) adapters.
