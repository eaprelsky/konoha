#!/bin/bash
# Periodic orchestration monitor — runs every 30 min via cron
# Injects a monitoring prompt into naruto tmux session via watchdog

/home/ubuntu/konoha/scripts/self-inject.sh 5 naruto "Плановый мониторинг (каждые 30 мин): проверь состояние всех агентов с активными задачами. Какаши — взял blocking issues #149-155? Что делает? Есть ли зависания? Отчитайся в Telegram Егору если есть отклонения, или просто зафиксируй что всё ок." &
