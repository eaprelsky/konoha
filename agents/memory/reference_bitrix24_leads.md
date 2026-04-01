---
name: Bitrix24 — создание лидов
description: Как создавать лиды в Bitrix24 через REST API: user_id сотрудников, endpoint, ограничения токена
type: reference
---

# Bitrix24 — создание лидов

**Webhook URL:** в `/opt/shared/.shared-credentials` (ключ `BITRIX24_WEBHOOK_URL`), домен `knwlab.bitrix24.ru`

## User ID сотрудников (для RESPONSIBLE_ID)

| Сотрудник | user_id | Когда использовать |
|-----------|---------|-------------------|
| Егор Апрельский (владелец, @yegor_aprelsky) | **19** | Ответственный по умолчанию |
| Саша Макаров (сейлз, @Ctrain2042) | **25** | Когда сделка ведётся Сашей |

> `user.get` требует скоуп выше токена — ID нельзя проверить через API, использовать значения из таблицы напрямую.

## Создание лида (crm.lead.add)

```bash
WEBHOOK="$(grep BITRIX24_WEBHOOK_URL /opt/shared/.shared-credentials | cut -d= -f2)"
curl -s -X POST "${WEBHOOK}crm.lead.add" \
  -H "Content-Type: application/json" \
  -d '{
    "fields": {
      "TITLE": "Название лида",
      "NAME": "Имя контакта",
      "LAST_NAME": "Фамилия контакта",
      "COMPANY_TITLE": "ООО Компания",
      "COMMENTS": "Описание и контекст лида",
      "RESPONSIBLE_ID": "25",
      "SOURCE_ID": "SELF",
      "STATUS_ID": "NEW"
    }
  }'
```

Ответ: `{"result": <lead_id>}` — ссылка на лид: `https://knwlab.bitrix24.ru/crm/lead/details/<lead_id>/`

## Вложения к лиду

Через `crm.timeline.comment.add` с base64-кодированным файлом (поле `FILES[N][fileData][0/1]`).

## Статусы лида

`NEW` → `IN_PROCESS` → `QUALIFIED` → `PROPOSAL` → `NEGOTIATION` → `WON` / `LOST`
