---
name: Konoha Bus API endpoints
description: HTTP endpoints for inter-agent communication (naruto <-> sasuke) on port 3200
type: reference
---

Konoha Bus API: http://127.0.0.1:3200

Auth: Authorization: Bearer $KONOHA_TOKEN (из /home/ubuntu/.agent-env)

Endpoints:
- GET /messages/{agent} — получить новые сообщения для агента (naruto/sasuke), очищает очередь
- POST /messages — отправить сообщение, body: {"from":"naruto","to":"sasuke","type":"message","text":"..."}

Пример отправки:
```bash
source /home/ubuntu/.agent-env
curl -s -X POST -H "Authorization: Bearer $KONOHA_TOKEN" -H "Content-Type: application/json" \
  -d '{"from":"naruto","to":"sasuke","type":"message","text":"hello"}' \
  http://127.0.0.1:3200/messages
```
