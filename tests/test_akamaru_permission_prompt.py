"""
Regression tests for konoha#537: Akamaru permission prompt false positives.
"""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from akamaru import classify_agent_process_tree, is_idle_prompt_state, is_permission_prompt_state
from akamaru import check_pid_fresh, _fresh_pids, _last_idle, FRESH_PID_GRACE_SEC
from unittest.mock import patch
import time


def test_idle_shortcuts_prompt_is_not_permission_prompt():
    lines = [
        "some previous output",
        "(Y/n)",  # stale scrollback from an old command
        "Esc to cancel",
        "❯ ? for shortcuts",
    ]

    assert is_permission_prompt_state(lines) is False


def test_real_permission_prompt_with_choice_ui_still_detected():
    lines = [
        "Do you want to proceed?",
        "❯ 1. Yes",
        "  2. No",
        "Don't ask again",
        "Esc to cancel",
        "❯ ? for shortcuts",
    ]

    assert is_permission_prompt_state(lines) is True


def test_claude_idle_prompt_is_detected():
    lines = [
        "previous output",
        "❯ ? for shortcuts",
    ]

    assert is_idle_prompt_state(lines) is True


def test_codex_idle_prompt_is_detected():
    lines = [
        "Task completed.",
        "› next task",
    ]

    assert is_idle_prompt_state(lines) is True


def test_codex_active_work_overrides_visible_prompt():
    lines = [
        "› previous prompt",
        "",
        "◦ Working (8s • esc to interrupt)",
    ]

    assert is_idle_prompt_state(lines) is False


def test_codex_queue_hint_is_busy_not_idle():
    lines = [
        "◦ Working (57s • esc to interrupt)",
        "",
        "› follow-up",
        "tab to queue message",
    ]

    assert is_idle_prompt_state(lines) is False


def test_codex_process_tree_is_classified():
    assert classify_agent_process_tree([
        "bash /home/ubuntu/konoha/scripts/agent-kakashi-service.sh",
        "/home/ubuntu/.npm-global/bin/codex --model gpt-5.5",
    ]) == "codex"


def test_claude_process_tree_is_classified():
    assert classify_agent_process_tree([
        "bash /home/ubuntu/konoha/scripts/agent-kakashi-service.sh",
        "claude --model deepseek-chat",
    ]) == "claude"


# ── Fresh-PID detection regression tests (refs #794, c3a5be9 review) ───────────

def _reset_pid_state():
    """Reset module-level PID tracking between tests."""
    _fresh_pids.clear()
    _last_idle.clear()


def test_fresh_pid_first_seen_returns_true():
    """First observation of a session PID is treated as fresh (grace active)."""
    _reset_pid_state()
    with patch("akamaru.tmux_pane_pid", return_value=4242):
        assert check_pid_fresh("testagent") is True
        # _last_idle must be set to current time
        assert "testagent" in _last_idle


def test_fresh_pid_within_grace_returns_true():
    """Same PID within grace period returns True."""
    _reset_pid_state()
    with patch("akamaru.tmux_pane_pid", return_value=4242):
        assert check_pid_fresh("testagent") is True  # first seen
        assert check_pid_fresh("testagent") is True  # still within grace


def test_fresh_pid_after_grace_returns_false():
    """Same PID after grace period expires returns False (alerts fire normally)."""
    _reset_pid_state()
    now = time.monotonic()
    with patch("akamaru.tmux_pane_pid", return_value=4242):
        # Simulate first seen at (now - grace - 1)
        _fresh_pids["testagent"] = (4242, now - FRESH_PID_GRACE_SEC - 1)
        _last_idle["testagent"] = now - FRESH_PID_GRACE_SEC - 1
        assert check_pid_fresh("testagent") is False


def test_pid_change_detected_as_fresh():
    """PID change resets idle tracker and starts new grace period."""
    _reset_pid_state()
    now = time.monotonic()
    # Old PID, long expired grace
    _fresh_pids["testagent"] = (1111, now - 9999)
    _last_idle["testagent"] = now - 9999
    with patch("akamaru.tmux_pane_pid", return_value=2222):
        assert check_pid_fresh("testagent") is True  # new PID → fresh
        assert _fresh_pids["testagent"][0] == 2222  # PID stored
        # _last_idle must be reset to current time, not keep the old value
        assert _last_idle["testagent"] >= now - 1


def test_old_pid_idle_does_not_produce_false_duration():
    """After PID change, _last_idle is reset so stuck duration is from new
    process birth, not from old PID idle timestamp. This prevents the
    '1000min stuck' false alert after agent restart."""
    _reset_pid_state()
    now = time.monotonic()
    old_idle_time = now - 100_000  # ~27 hours — old PID was idle long ago
    _fresh_pids["testagent"] = (1111, old_idle_time)
    _last_idle["testagent"] = old_idle_time

    with patch("akamaru.tmux_pane_pid", return_value=2222):
        assert check_pid_fresh("testagent") is True
        # After PID change, _last_idle must be close to now, not old_idle_time
        assert _last_idle["testagent"] >= now - 2
        # Stuck duration from new _last_idle would be < 2s, not 100000s


def test_pid_none_returns_false():
    """None PID (tmux session missing) returns False — not fresh."""
    _reset_pid_state()
    with patch("akamaru.tmux_pane_pid", return_value=None):
        assert check_pid_fresh("testagent") is False
        assert "testagent" not in _fresh_pids


def test_grace_boundary_exact():
    """At exactly the grace boundary, check_pid_fresh returns False."""
    _reset_pid_state()
    now = time.monotonic()
    with patch("akamaru.tmux_pane_pid", return_value=4242):
        _fresh_pids["testagent"] = (4242, now - FRESH_PID_GRACE_SEC)
        _last_idle["testagent"] = now - FRESH_PID_GRACE_SEC
        assert check_pid_fresh("testagent") is False
