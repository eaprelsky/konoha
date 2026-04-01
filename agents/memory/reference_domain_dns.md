---
name: Domain DNS and wildcard cert
description: eaprelsky.ru has wildcard DNS and cert — new subdomains work automatically; port 443 can be SNI-proxied via nginx
type: reference
---

Domain: eaprelsky.ru (and subdomains: agent.eaprelsky.ru, etc.)

**Wildcard DNS**: *.agent.eaprelsky.ru (and possibly *.eaprelsky.ru) — wildcard record exists, no need to add individual A records for new subdomains.

**Port 443**: Occupied by mailcow Docker, but can be SNI-proxied via nginx stream module — route specific subdomains (e.g. dash.agent.eaprelsky.ru) to nginx, pass mail.eaprelsky.ru to mailcow backend.

**Wildcard cert**: Check /etc/letsencrypt/live/ for a wildcard cert (*.agent.eaprelsky.ru or *.eaprelsky.ru). If exists, use it for new subdomains directly.

**How to apply**: When setting up a new subdomain — no DNS needed, just get/use wildcard cert and configure nginx stream SNI routing on port 443.
