"""
Regression tests for konoha#537: Akamaru permission prompt false positives.
"""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from akamaru import classify_agent_process_tree, is_idle_prompt_state, is_permission_prompt_state


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
