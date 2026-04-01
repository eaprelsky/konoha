---
name: Telegram group chat IDs
description: Chat IDs групповых чатов в Telegram — для ответов через tg-send-user.py
type: reference
---

## Известные групповые чаты (Telethon user account)

| chat_id | Название | Описание |
|---------|----------|----------|
| 93791246 | Yegor Aprelsky | Личка Егора |
| -4982206077 | coMind Лиды | Группа продаж/лидов; участники: yegor_aprelsky, asdobrotvorskiy (Лёша) и др. |
| -531788843 | coMind | Общий чат команды coMind |

## Как использовать
- Сообщения из telegram:incoming содержат поле `chat_id` и `chat_title` в Redis stream
- Всегда отвечать в тот же chat_id откуда пришло сообщение
- Не отвечать Егору в личку если задача пришла из группы
