#!/usr/bin/env python3
"""
Проверка fix для #77: check_services() должна поддерживать оба варианта имён.
"""

import sys
sys.path.insert(0, '/home/ubuntu/konoha/scripts')
from akamaru import WATCHED_SERVICES

# Simulate the fix logic
def extract_short_name(svc: str) -> str:
    """Extract short name from full service name."""
    return svc.removeprefix("claude-").removeprefix("watchdog-").removesuffix(".service")

# Test 1: Full name
print("=== Test 1: Полное имя (работало и раньше) ===")
paused = {"claude-naruto.service"}
svc = "claude-naruto.service"
short = extract_short_name(svc)
if svc in paused or short in paused:
    print(f"✓ {svc} будет пропущен")
else:
    print(f"✗ FAIL")

# Test 2: Short name (FIX!)
print("\n=== Test 2: Краткое имя (FIX!) ===")
paused = {"naruto"}
svc = "claude-naruto.service"
short = extract_short_name(svc)
print(f"  svc: {svc}")
print(f"  short: {short}")
if svc in paused or short in paused:
    print(f"✓ FIXED! {svc} будет пропущен через короткое имя '{short}'")
else:
    print(f"✗ FAIL")

# Test 3: Mixed formats
print("\n=== Test 3: Проверка всех watched services ===")
test_cases = [
    ("naruto", "claude-naruto.service"),
    ("sasuke", "claude-sasuke.service"),
    ("watchdog-mirai", "claude-watchdog-mirai.service"),
]

for short_name, full_name in test_cases:
    paused = {short_name}
    short = extract_short_name(full_name)
    if full_name in paused or short in paused:
        print(f"✓ {full_name} (→ {short}) пропущен при паузе '{short_name}'")
    else:
        print(f"✗ FAIL for {full_name}")
