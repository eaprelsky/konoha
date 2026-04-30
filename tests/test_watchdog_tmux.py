import asyncio
import os
import sys


sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))


def test_codex_working_marker_overrides_visible_previous_prompt():
    import watchdog_tmux

    pane = """
› Previous prompt still visible in scrollback


◦ Working (8s • esc to interrupt)
"""

    assert watchdog_tmux._has_idle_prompt(pane) is False


def test_old_working_marker_before_current_prompt_does_not_confirm_submission():
    import watchdog_tmux

    pane = """
◦ Working (8s • esc to interrupt)

› deliver this prompt
"""

    assert watchdog_tmux._has_active_work_after_prompt(pane, "deliver this prompt") is False
    assert watchdog_tmux._has_idle_prompt(pane) is True


def test_codex_queue_hint_is_not_idle():
    import watchdog_tmux

    pane = """
◦ Working (57s • esc to interrupt)

› next task

tab to queue message
"""

    assert watchdog_tmux._has_idle_prompt(pane) is False


def test_working_marker_after_current_prompt_confirms_submission():
    import watchdog_tmux

    pane = """
› deliver this prompt

◦ Working (1s • esc to interrupt)
"""

    assert watchdog_tmux._has_active_work_after_prompt(pane, "deliver this prompt") is True


def test_tmux_send_retries_when_pane_changes_but_agent_stays_idle(monkeypatch):
    import watchdog_tmux

    enter_count = {"value": 0}
    monotonic = {"value": 0.0}

    def fake_monotonic():
        monotonic["value"] += 0.6
        return monotonic["value"]

    def fake_capture(_session):
        if enter_count["value"] >= 2:
            return True, "◦ Working on your request"
        if enter_count["value"] == 1:
            return True, "› deliver this prompt "
        return True, "› deliver this prompt"

    cleared = {"value": False}

    async def fake_tmux_run(*args, timeout=10.0):
        if args[-1] == "C-u":
            cleared["value"] = True
        if args[-1] == "Enter":
            enter_count["value"] += 1
        return True

    async def fake_sleep(_seconds):
        return None

    monkeypatch.setattr(watchdog_tmux, "is_session_alive", lambda _session: True)
    monkeypatch.setattr(watchdog_tmux, "tmux_pane_capture", fake_capture)
    monkeypatch.setattr(watchdog_tmux, "tmux_run", fake_tmux_run)
    monkeypatch.setattr(watchdog_tmux.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(watchdog_tmux.time, "monotonic", fake_monotonic)

    delivered = asyncio.run(watchdog_tmux.tmux_send("kakashi", "deliver this prompt"))

    assert delivered is True
    assert cleared["value"] is True
    assert enter_count["value"] == 2


def test_tmux_send_ignores_old_working_marker_before_current_prompt(monkeypatch):
    import watchdog_tmux

    enter_count = {"value": 0}
    monotonic = {"value": 0.0}

    def fake_monotonic():
        monotonic["value"] += 0.6
        return monotonic["value"]

    def fake_capture(_session):
        if enter_count["value"] >= 2:
            return True, "› deliver this prompt\n\n◦ Working on your request"
        if enter_count["value"] == 1:
            return True, "◦ Working on previous request\n\n› deliver this prompt"
        return True, "› deliver this prompt"

    async def fake_tmux_run(*args, timeout=10.0):
        if args[-1] == "Enter":
            enter_count["value"] += 1
        return True

    async def fake_sleep(_seconds):
        return None

    monkeypatch.setattr(watchdog_tmux, "is_session_alive", lambda _session: True)
    monkeypatch.setattr(watchdog_tmux, "tmux_pane_capture", fake_capture)
    monkeypatch.setattr(watchdog_tmux, "tmux_run", fake_tmux_run)
    monkeypatch.setattr(watchdog_tmux.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(watchdog_tmux.time, "monotonic", fake_monotonic)

    delivered = asyncio.run(watchdog_tmux.tmux_send("kakashi", "deliver this prompt"))

    assert delivered is True
    assert enter_count["value"] == 2


def test_tmux_send_fails_if_agent_never_leaves_idle(monkeypatch):
    import watchdog_tmux

    enter_count = {"value": 0}
    monotonic = {"value": 0.0}

    def fake_monotonic():
        monotonic["value"] += 0.6
        return monotonic["value"]

    async def fake_tmux_run(*args, timeout=10.0):
        if args[-1] == "Enter":
            enter_count["value"] += 1
        return True

    async def fake_sleep(_seconds):
        return None

    monkeypatch.setattr(watchdog_tmux, "is_session_alive", lambda _session: True)
    monkeypatch.setattr(watchdog_tmux, "tmux_pane_capture", lambda _session: (True, "› prompt still idle"))
    monkeypatch.setattr(watchdog_tmux, "tmux_run", fake_tmux_run)
    monkeypatch.setattr(watchdog_tmux.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(watchdog_tmux.time, "monotonic", fake_monotonic)

    delivered = asyncio.run(watchdog_tmux.tmux_send("kakashi", "prompt still idle"))

    assert delivered is False
    assert enter_count["value"] == 4
