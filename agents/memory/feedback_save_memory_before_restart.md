---
name: Always save memory before requesting a restart
description: Before asking user to restart session, always persist current context and progress to memory files
type: feedback
---

Всегда сохранять память перед тем, как просить перезагрузку сессии.

**Why:** При рестарте весь контекст разговора теряется. Если не записать прогресс и решения в память, следующая сессия начнёт с нуля и может повторить уже пройденные шаги.

**How to apply:** Перед любым предложением "давай перезапустим сессию" — сначала обновить все релевантные memory-файлы с текущим состоянием работы, принятыми решениями и следующими шагами.
