---
name: Agent infrastructure overview
description: Full stack of agent capabilities - servers, services, credentials, VNC, browser
type: reference
---

## Agent Machine (claudea)
- VK Cloud, IP: 146.185.240.120 (floating), 10.0.0.254 (internal)
- VPN exit IP: 194.146.25.40 (used for outbound traffic)
- Docker installed, Mailcow running
- Xvfb :99 + x11vnc + noVNC (port 6080, password: agent2026)
- PulseAudio with virtual devices (meeting_speaker, virtual_mic)
- Playwright + stealth browser (/home/ubuntu/browser.js)
- Persistent browser profile: /home/ubuntu/.browser-profile

## Services & Credentials (/opt/shared/.shared-credentials)
- VK Cloud (service account, network admin role)
- Voximplant (ID: 9270901, app: voice.rsukhlab.voximplant.com)
- Telnyx (Business account, Call Control app ID: 2922044701076882780)
- OpenAI API (GPT-4o-mini, Whisper STT, TTS)
- Freepik API
- Credit card on file ($50 budget)
- GitHub PAT (~/.github-token) with Administration access

## DNS (VK Cloud Public DNS API)
- Base URL: https://mcs.mail.ru/public-dns/v2/dns/
- eaprelsky.ru zone UUID: 46b50c3b-9bf6-4445-aea0-008d1cf73b9b
- nocturna.ru zone also available

## Open Ports (VK Cloud security group "vnc-claude")
TCP 25, 143, 443, 587, 993, 3000, 6080

## Known Issues
- Cloudflare Turnstile/hCaptcha blocks automated registration (Twilio banned, ElevenLabs sanctioned)
- Telnyx cannot call Russia (needs account upgrade)
- Voximplant VoxEngine ASR doesn't work on the account
- Chromium + PulseAudio virtual mic not working in Telemost (needs debugging)
- VPN IP (194.146.25.40) flagged by some services

## Voice Agent (github.com/eaprelsky/voice-agent)
- server.js: Express webhook for Telnyx + Voximplant, OpenAI STT/TTS proxy
- meeting-agent.js: Telemost meeting participant (WIP - mic issue)
- Voximplant scenario ID: 3218254, rule ID: 8559254
