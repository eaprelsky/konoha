# Agent Memory Index — Shared (Naruto + Sasuke)

> Shared memory for all Claude agents. Path: /opt/shared/agent-memory/
> Managed manually — auto-memory is disabled.

## User
- [user_yegor.md](user_yegor.md) — Primary user profile: Yegor Aprelsky, CTO of coMind, communicates via Telegram in Russian

## Feedback
- [feedback_bitrix24_verify_changes.md](feedback_bitrix24_verify_changes.md) — После изменений в воронке — проверять Bitrix24 и подтверждать фактом, не словами
- [feedback_kakashi_fixed_flow.md](feedback_kakashi_fixed_flow.md) — After closing issue: kakashi:fixed → Shino FIRST, then Naruto. Shino triggers Hinata (HARD GATE).
- [feedback_autonomy.md](feedback_autonomy.md) — Work autonomously, ask only at real decision forks (not routine progress)
- [feedback_autonomous_decisions.md](feedback_autonomous_decisions.md) — Действовать автономно, не переспрашивать Егора по каждому поводу
- [feedback_chat_style.md](feedback_chat_style.md) — Chat style preferences
- [feedback_communication_etiquette.md](feedback_communication_etiquette.md) — Всегда делать ack сообщений, сразу говорить "понял, работаю" если нужно время
- [feedback_dont_hallucinate.md](feedback_dont_hallucinate.md) — Don't hallucinate facts
- [feedback_group_chats.md](feedback_group_chats.md) — Group chat behavior rules
- [feedback_identity_correction.md](feedback_identity_correction.md) — Always correct Yegor if he misidentifies which agent he's talking to
- [feedback_mcp_config_update.md](feedback_mcp_config_update.md) — MCP config update requires terminal Enter — Naruto can send Enter to Sasuke via tmux
- [feedback_parallel_tasks.md](feedback_parallel_tasks.md) — Run long tasks in background by default, keep chat responsive
- [feedback_read_all_memory_on_startup.md](feedback_read_all_memory_on_startup.md) — При старте читать ВСЕ файлы памяти, искать незавершённые задачи
- [feedback_report_task_completion.md](feedback_report_task_completion.md) — Репортить о завершении задач, не замалчивать результаты
- [feedback_restart_via_sasuke.md](feedback_restart_via_sasuke.md) — Рестарт просить через Саске (Konoha bus), не дергать Егора
- [feedback_save_memory_before_restart.md](feedback_save_memory_before_restart.md) — Всегда сохранять память перед запросом на перезагрузку сессии
- [feedback_send_via_bot.md](feedback_send_via_bot.md) — Наруто отправляет через telegram:bot:outgoing (бот). Саске — через telegram:outgoing (Telethon)
- [feedback_spending_approval.md](feedback_spending_approval.md) — Always notify and get approval before any spending
- [feedback_telegram_markdown.md](feedback_telegram_markdown.md) — Use plain text in Telegram (no MarkdownV2)
- [feedback_telegram_plain_text.md](feedback_telegram_plain_text.md) — Send TG messages as plain text, no MarkdownV2 escaping
- [feedback_track_changes.md](feedback_track_changes.md) — Вести историю изменений, не добавлять/убирать одно и то же по кругу
- [feedback_naruto_orchestrator_role.md](feedback_naruto_orchestrator_role.md) — Наруто НЕ фиксит код сам — создаёт GitHub Issues, делегирует Какаши
- [feedback_no_manual_queue_poll.md](feedback_no_manual_queue_poll.md) — НЕ читать message-queue.jsonl вручную при старте — watchdog сам доставляет новые сообщения
- [feedback_group_standup_links.md](feedback_group_standup_links.md) — Не отвечать на ссылки на встречи и стендап-контент в группах (без прямого обращения)
- [feedback_group_fyi_messages.md](feedback_group_fyi_messages.md) — FYI-сообщения в группах (переписки, хэштеги) — не требуют действий от Клода
- [feedback_notify_on_context_limit.md](feedback_notify_on_context_limit.md) — Уведомлять Егора через бот при приближении к лимиту контекста
- [feedback_session_cleanup_silent.md](feedback_session_cleanup_silent.md) — Session cleanup полностью автономен, Егора не беспокоить
- [feedback_guy_delegation_chain.md](feedback_guy_delegation_chain.md) — Гай получает задачи только от Какаши, не от Егора/Наруто напрямую

## Projects
- [hinata_status.md](hinata_status.md) — Hinata (Agent #6) startup status: online, registered, ready for testing tasks
- [project_ai_native_comind.md](project_ai_native_comind.md) — AI Native initiative at coMind; Nocturna as test case for virtual AI company
- [project_callsigns.md](project_callsigns.md) — Agent callsigns: Naruto (#1, bot), Sasuke (#2, user account), Mirai (#3)
- [project_konoha.md](project_konoha.md) — Konoha: multi-agent communication bus (Redis + HTTP API + MCP), ~/konoha
- [project_mirai.md](project_mirai.md) — Mirai (Мирай): Agent #3, Haiku-based Claude Code session in tmux mirai, event-driven via watchdog
- [project_mcp_push_bug.md](project_mcp_push_bug.md) — Push workaround: standalone Grammy bot + polling check_messages
- [project_naruto_channel_changelog.md](project_naruto_channel_changelog.md) — Инфраструктура: текущее состояние, транспорты, TODO
- [project_naruto_channel_debug.md](project_naruto_channel_debug.md) — Push notifications: experimental claude/channel capability (fixed 2026-03-24)
- [project_sasuke_decisions.md](project_sasuke_decisions.md) — Sasuke: telegram:incoming + tg-send-user.py. Naruto: telegram:bot:incoming + tg-send.py
- [project_sasuke_session_2.md](project_sasuke_session_2.md) — Архитектура Саске: транспорт, скрипты, nginx/SSL, consumer group
- [project_telegram_proxy_fix.md](project_telegram_proxy_fix.md) — Patched grammy fetch shim to fix photo uploads through HTTP proxy in bun
- [project_watchdog.md](project_watchdog.md) — Event-driven watchdog services (systemd) replacing cron loops for agents

- [project_akamaru_deploy.md](project_akamaru_deploy.md) — systemd запускает /home/ubuntu/scripts/akamaru.py, git-репо в /home/ubuntu/konoha/scripts/ — разные файлы, оба нужно обновлять
- [project_ino_status.md](project_ino_status.md) — Ино остановлена по запросу Егора. НЕ запускать без его разрешения.
- [project_jiraiya_status.md](project_jiraiya_status.md) — Дзирайя остановлен по запросу Егора. НЕ запускать — требует перепроектирования перед следующим стартом.

## References
- [reference_telegram_groups.md](reference_telegram_groups.md) — Chat IDs групп Telegram: coMind Лиды (-4982206077), coMind (-531788843)
- [reference_staff_directory.md](reference_staff_directory.md) — Где искать контакты сотрудников: .trusted-users.json + Yonote doc
- [reference_agent_infra.md](reference_agent_infra.md) — Full agent infrastructure: VNC, browser, services, credentials, known issues
- [reference_konoha_api.md](reference_konoha_api.md) — Konoha Bus API: GET /messages/{agent}, POST /messages (port 3200)
- [reference_konoha_urls.md](reference_konoha_urls.md) — Konoha URLs: localhost for server agents, https://agent.eaprelsky.ru for WSL/remote
- [reference_mail_server.md](reference_mail_server.md) — Mailcow mail server at mail.eaprelsky.ru, accounts, API, DNS
- [reference_bitrix24_leads.md](reference_bitrix24_leads.md) — Bitrix24: создание лидов, user_id сотрудников (Саша=25), crm.lead.add API
- [reference_naruto_vkcloud.md](reference_naruto_vkcloud.md) — Наруто умеет модерировать сети и порты в VK Cloud
- [reference_nocturna_project.md](reference_nocturna_project.md) — Full Nocturna architecture: 5 microservices, repos, server layout
- [reference_nocturna_server.md](reference_nocturna_server.md) — SSH access to nocturna.ru for managing eaprelsky.ru Hugo site
- [reference_phone_numbers.md](reference_phone_numbers.md) — Agent phone numbers: RU +79011477544 (Voximplant), US +13024008212 (Telnyx)
- [project_agent_identities.md](project_agent_identities.md) — Пол, модель и роль каждого агента (Хината и Мирай — женского рода; единые кириллические имена)
- [feedback_scripts_vs_konoha_deploy.md](feedback_scripts_vs_konoha_deploy.md) — Fix both /home/ubuntu/scripts/ (deployed, systemd) AND /home/ubuntu/konoha/scripts/ (git repo) when patching agent scripts
