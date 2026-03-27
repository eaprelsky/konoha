#!/usr/bin/env python3
"""
Воспроизведение bug #77: check_services() не пропускает paused сервисы
когда используются краткие имена вместо полных.
"""

import sys
sys.path.insert(0, '/home/ubuntu/konoha/scripts')
from akamaru import load_paused, WATCHED_SERVICES

# Test 1: Full name works
print("=== Test 1: Полное имя ===")
paused_full = {"claude-naruto.service"}
for svc in WATCHED_SERVICES[:3]:
    if svc in paused_full:
        print(f"✓ {svc} будет пропущен (паузирован)")
    else:
        print(f"✗ {svc} НЕ будет пропущен (проверяется)")

# Test 2: Short name FAILS
print("\n=== Test 2: Краткое имя (BUG!) ===")
paused_short = {"naruto", "sasuke", "mirai"}
for svc in WATCHED_SERVICES[:3]:
    if svc in paused_short:
        print(f"✓ {svc} будет пропущен (паузирован)")
    else:
        print(f"✗ {svc} НЕ будет пропущен (BUG! должен был быть пропущен)")

# Test 3: Mixed (some work, some fail)
print("\n=== Test 3: Смешанные имена ===")
paused_mixed = {"claude-naruto.service", "sasuke", "mirai"}  
for svc in WATCHED_SERVICES[:3]:
    if svc in paused_mixed:
        print(f"✓ {svc} будет пропущен")
    else:
        print(f"✗ {svc} НЕ будет пропущен")
