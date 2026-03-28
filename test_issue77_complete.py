#!/usr/bin/env python3
"""
Полная проверка fix для #77
"""

import sys
sys.path.insert(0, '/home/ubuntu/konoha/scripts')

def extract_short_name(svc: str) -> str:
    return svc.removeprefix("claude-").removeprefix("watchdog-").removesuffix(".service")

# Test all cases
test_cases = [
    # (paused_name, full_svc_name, should_match)
    ("naruto", "claude-naruto.service", True),
    ("sasuke", "claude-sasuke.service", True),
    ("mirai", "claude-mirai.service", True),
    ("watchdog-mirai", "claude-watchdog-mirai.service", True),
    ("mirai", "claude-watchdog-mirai.service", True),  # Also matches short form
    ("claude-naruto.service", "claude-naruto.service", True),  # Full name
    ("hinata", "claude-hinata.service", True),
]

print("=== Тестирование всех вариантов паузирования ===\n")
failures = 0
for paused_name, full_svc, expected in test_cases:
    short = extract_short_name(full_svc)
    matches = paused_name in {full_svc, short}
    
    status = "✓" if matches == expected else "✗"
    if matches != expected:
        failures += 1
    
    print(f"{status} paused='{paused_name}' svc='{full_svc}' (→'{short}') → {matches}")

print(f"\n{'✓ ALL PASS' if failures == 0 else f'✗ {failures} FAILURES'}")
