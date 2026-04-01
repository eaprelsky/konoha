---
name: Mail server on agent machine
description: Mailcow mail server at mail.eaprelsky.ru - setup, accounts, admin access
type: reference
---

Mailcow mail server running on the agent's local machine (146.185.240.120).

**Domain:** eaprelsky.ru
**Web UI:** https://mail.eaprelsky.ru
**Webmail (SOGo):** https://mail.eaprelsky.ru/SOGo/
**Admin:** https://mail.eaprelsky.ru → "Войти как администратор", login: admin

**Mailboxes:**
- me@eaprelsky.ru — Yegor's personal
- agent@eaprelsky.ru — Claude Agent (password in /opt/shared/.shared-credentials or generate new via API)
- service@eaprelsky.ru — alias → me@

**Mailcow API key:** mailcow-eaprelsky-api-2026 (set in /opt/mailcow/mailcow.conf)

**DNS records added via VK Cloud Public DNS API:**
- A: mail → 146.185.240.120
- MX: @ → mail.eaprelsky.ru (priority 10)
- TXT: @ → SPF (v=spf1 mx a:mail.eaprelsky.ru ~all)
- TXT: dkim._domainkey → DKIM key
- TXT: _dmarc → DMARC policy
- CNAME: autodiscover, autoconfig → mail.eaprelsky.ru

**Pending:** PTR record (requested from VK Cloud support).

**VK Cloud DNS API:** base URL https://mcs.mail.ru/public-dns/v2/dns/, zone UUID for eaprelsky.ru: 46b50c3b-9bf6-4445-aea0-008d1cf73b9b
