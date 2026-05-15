"""
Regression tests for Naruto watchdog L1 interrupt and startup grace (refs #794).

Naruto is the orchestrator — L1 owner interrupts must fire within 30s even
when the 600s startup grace period is active.
"""

import importlib.util
import os


def _load_watchdog_naruto():
    path = os.path.join(os.path.dirname(__file__), "..", "scripts", "watchdog-naruto.py")
    spec = importlib.util.spec_from_file_location("watchdog_naruto_test", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


# ── L1 detection unit tests ───────────────────────────────────────────────────

def test_has_l1_message_detects_owner_by_user_id():
    """L1 detection: owner user_id triggers has_l1_message."""
    module = _load_watchdog_naruto()
    assert module.has_l1_message([{
        "source": "telegram",
        "data": {"text": "hi", "user_id": "93791246"},
    }]) is True


def test_has_l1_message_detects_owner_by_trust_level():
    """L1 detection: trust_level=1 triggers has_l1_message."""
    module = _load_watchdog_naruto()
    assert module.has_l1_message([{
        "source": "telegram",
        "data": {"text": "hi", "user_id": "99999999", "trust_level": "1"},
    }]) is True


def test_has_l1_message_ignores_non_owner():
    """Non-owner non-L1 message is not detected as L1."""
    module = _load_watchdog_naruto()
    assert module.has_l1_message([{
        "source": "telegram",
        "data": {"text": "hi", "user_id": "12345678"},
    }]) is False


def test_has_l1_message_ignores_konoha_only():
    """Konoha SSE messages (no Telegram source) are not L1."""
    module = _load_watchdog_naruto()
    assert module.has_l1_message([{
        "source": "konoha",
        "data": {"text": "some alert"},
    }]) is False


# ── Grace / L1 ordering verification ──────────────────────────────────────────

def test_l1_check_precedes_grace_sleep_in_send_loop(monkeypatch):
    """Verify that the L1 interrupt check (line 316) is before the grace sleep
    (line 324) in naruto's send_loop wait phase.

    This is a structural test: it confirms the source-code ordering that
    ensures L1 fires during startup grace. The code change from 05017d5
    moved the L1 check above `if grace_deadline > now: sleep; continue`.
    """
    path = os.path.join(os.path.dirname(__file__), "..", "scripts", "watchdog-naruto.py")
    lines = open(path).readlines()

    # Find the send_loop wait loop and check L1-vs-grace ordering
    in_wait_loop = False
    l1_line = -1
    grace_sleep_line = -1
    for i, line in enumerate(lines):
        if "waited = 0.0" in line and "grace_deadline" not in line:
            in_wait_loop = True
            continue
        if not in_wait_loop:
            continue
        if "L1 priority interrupt" in line or "L1_INTERRUPT_AFTER_SEC and has_l1_message" in line:
            l1_line = i
        if "grace_deadline > now" in line:
            grace_sleep_line = i
        if l1_line > 0 and grace_sleep_line > 0:
            break

    assert l1_line > 0, "L1 interrupt check not found in send_loop wait phase"
    assert grace_sleep_line > 0, "grace_deadline sleep not found in send_loop wait phase"
    assert l1_line < grace_sleep_line, (
        f"L1 check (line {l1_line + 1}) must be BEFORE grace sleep "
        f"(line {grace_sleep_line + 1}) so owner interrupts fire during startup grace. "
        f"Current order has grace sleep first — L1 blocked for up to 600s."
    )


def test_l1_waited_accrues_during_grace_sleep(monkeypatch):
    """Verify that `waited` counter is incremented during grace sleep so L1
    can trigger after L1_INTERRUPT_AFTER_SEC regardless of grace state."""
    path = os.path.join(os.path.dirname(__file__), "..", "scripts", "watchdog-naruto.py")
    lines = open(path).readlines()

    in_wait_loop = False
    in_grace_block = False
    waited_in_grace = False
    for i, line in enumerate(lines):
        if "waited = 0.0" in line and "grace_deadline" not in line:
            in_wait_loop = True
            continue
        if not in_wait_loop:
            continue
        if "grace_deadline > now" in line:
            in_grace_block = True
            continue
        if in_grace_block and "waited += sleep_time" in line:
            waited_in_grace = True
            break
        if in_grace_block and "}" in line:
            in_grace_block = False

    assert waited_in_grace, (
        "waited must be incremented during grace sleep so L1 can fire after "
        "L1_INTERRUPT_AFTER_SEC even during startup grace"
    )
