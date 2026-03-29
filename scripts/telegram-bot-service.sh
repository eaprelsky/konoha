#!/bin/bash
set -a; source /home/ubuntu/.agent-env; set +a

# bot.ts writes to LOG_FILE directly via appendFileSync — don't redirect stderr here (causes duplicate lines)
exec /home/ubuntu/.bun/bin/bun run /home/ubuntu/telegram-bot-service/bot.ts 2>/dev/null
