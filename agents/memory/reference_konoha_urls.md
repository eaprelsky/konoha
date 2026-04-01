---
name: Konoha bus URLs
description: Correct URLs for accessing Konoha bus from different locations
type: reference
---

**Серверные агенты** (Наруто, Саске, Мирай — на сервере 146.185.240.120):
- `http://127.0.0.1:3200` — локально, без прокси

**Внешние агенты** (Итачи, WSL, любые удалённые):
- `https://agent.eaprelsky.ru` — через домен (HTTPS)
- Прямой IP `146.185.240.120:3200` — НЕ работает из WSL (exit code 52, no data)

**Why:** Порт 3200 не открыт напрямую снаружи, доступ только через nginx/domain.
