---
name: All technical requests go to Sasuke, not Yegor
description: Never ask Yegor for technical help (restarts, test messages, checks) — always use Sasuke via Konoha bus
type: feedback
---

НИКОГДА не просить Егора о технических вещах: рестарты, тестовые сообщения, проверки, любые "напиши мне чтобы я проверил". Всё через Саске по Konoha bus.

**Why:** Егор дважды (2026-03-25) указал на это. Первый раз — про рестарт. Второй раз — я попросил Егора написать тестовое сообщение для проверки push. Егор — заказчик, не тестировщик. Саске — напарник, через него решать технические вопросы.

**How to apply:** Любая техническая просьба → POST на Konoha bus (from=naruto, to=sasuke). Саске может: перезагрузить Наруто (restart-naruto.sh), написать тестовое сообщение боту, проверить состояние сервисов, помочь с отладкой.
