# Secret rotation checklist — post-#768

After removing embedded secrets from 23 `.mcp.json` / `.cursor/mcp.json` / `opencode.json` files (#768), the exposed tokens should be rotated. This document lists every token that was visible in version-controlled configs and how to rotate it.

## Tokens that were exposed

| Token | Provider | Rotate via | Impact if compromised |
|---|---|---|---|
| `KONOHA_TOKEN` | Konoha bus | Generate new token, update `.agent-env`, restart agents | Agent impersonation, message interception |
| `KONOHA_MIRAI_TOKEN` | Konoha bus (mirai) | Same as above | Same |
| `KONOHA_SHINO_TOKEN` | Konoha bus (shino) | Same as above | Same |
| `TRACKER_TOKEN` | Yandex Tracker OAuth | Yandex Tracker admin panel → regenerate token | Tracker data read/write |
| `TRACKER_CLOUD_ORG_ID` | Yandex Cloud org | Yandex Cloud console | Tracker access scoping |
| `GITLAB_PERSONAL_ACCESS_TOKEN` | GitLab (KNwLab) | GitLab Settings → Access Tokens → rotate | Git repo access, pipeline triggers |
| `YONOTE_API_KEY` | Yonote | Yonote admin panel → API keys | Document read/write |
| `CALDAV_USERNAME` / `CALDAV_PASSWORD` | Yandex CalDAV | Yandex Passport → app passwords | Calendar read |
| `OPENROUTER_API_KEY` | OpenRouter | OpenRouter dashboard → API keys | LLM API billing abuse |
| `MIRO_API_TOKEN` | Miro | Miro developer settings → rotate token | Board read/write |
| `BITRIX24_WEBHOOK_URL` (both variants) | Bitrix24 | Bitrix24 admin → webhooks → regenerate | CRM data access |

## Rotation procedure

1. **Check which tokens are actually still valid** — some may have been rotated already during normal operations.
2. **For each token**: generate a new credential at the provider, update `/home/ubuntu/.agent-env` with the new value.
3. **Restart affected services**: agents using the rotated token may need a restart if they cache env vars.
4. **Verify**: run `scripts/check-mcp-secrets.sh` to confirm no raw secrets remain.
5. **Revoke old tokens** at each provider once the new ones are confirmed working.

## Verification

```bash
# Confirm no raw secrets in MCP configs
bash scripts/check-mcp-secrets.sh

# Confirm all env vars resolve (dry-run from agent context)
source ~/.agent-env && echo "KONOHA_TOKEN=${KONOHA_TOKEN:0:4}..."
```

## Related

- Issue: [#768](https://github.com/eaprelsky/konoha/issues/768)
- Script: `scripts/check-mcp-secrets.sh`
