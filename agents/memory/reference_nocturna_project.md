---
name: Nocturna project architecture
description: Full architecture of Nocturna astrology bot - 5 microservices, server layout, repos
type: reference
---

Nocturna — астрологический Telegram-бот. Микросервисная архитектура, 5 компонентов:

1. **nocturna-calculations** — Python/FastAPI, швейцарские эфемериды, REST API расчётов. Repo: github.com/eaprelsky/nocturna-calculations (public). Docker, 92+ тестов.

2. **nocturna-wheel** — JS библиотека визуализации натальных карт в SVG. npm: @eaprelsky/nocturna-wheel. Repo: github.com/eaprelsky/nocturna-wheel (public). Zero dependencies.

3. **nocturna-image** — Node.js/Express/Puppeteer, рендеринг карт в PNG/SVG/JPEG. Repo: github.com/eaprelsky/nocturna-image (public). Blue-green деплой, Prometheus.

4. **nocturna-tg** — Python/python-telegram-bot, основной бот. ~5300 строк. LLM интерпретации через OpenRouter (Claude Haiku). Оплата через YooKassa. PostgreSQL. Repo: приватный. На сервере: /opt/deprecated/nocturna-tg (но работает, порт 8082 green).

5. **nocturna-landing** — Next.js 16 + Tailwind, лендинг nocturna.ru. Repo: github.com/eaprelsky/nocturna-landing (приватный). На сервере: /var/www/nocturna.ru

Также на сервере nocturna.ru:
- Блог eaprelsky.ru (Hugo) — /var/www/eaprelsky.ru
- Демо wheel — /var/www/demo.wheel.nocturna.ru
- Zen Match — /var/www/zen-match

Archived repos (old web-app attempts, not active): nocturna, nocturna-app, nocturna-saas-backend.

Note: wheel was originally built for a web app (SVG in browser). When project pivoted to Telegram, image service with Puppeteer was added as a bridge to render SVG to PNG. Potential future refactor: generate SVG in Python directly.

GitHub PAT saved at ~/.github-token on both servers (local and nocturna.ru).

Сервер: nocturna.ru (hostname: nocturna-sunrise). Nginx, Let's Encrypt, Docker для calculations.
