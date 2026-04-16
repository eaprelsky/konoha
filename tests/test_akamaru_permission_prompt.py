"""
Regression tests for konoha#537: Akamaru permission prompt false positives.
"""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from akamaru import is_permission_prompt_state


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
