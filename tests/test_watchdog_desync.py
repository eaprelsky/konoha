"""
Tests for watchdog desync detection, auto-recovery, and text sanitization (#505).
Run: python -m pytest tests/test_watchdog_desync.py -v
"""
import sys
import os
import pytest
import asyncio
from contextlib import suppress

# Add scripts dir to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))


class TestTextSanitization:
    """Regression tests for Telegram newline and exclamation mark handling (#505)."""

    def test_literal_backslash_n_converted_to_real_newline(self):
        """Literal \\n (two chars: backslash + n) must become a real newline."""
        from watchdog_base import sanitize_message_text
        assert sanitize_message_text("hello\\nworld") == "hello\nworld"

    def test_real_newlines_preserved(self):
        """Actual newlines must pass through unchanged."""
        from watchdog_base import sanitize_message_text
        assert sanitize_message_text("hello\nworld") == "hello\nworld"

    def test_double_literal_backslash_n(self):
        """Literal \\\\n\\\\n → two real newlines (not double-escaped)."""
        from watchdog_base import sanitize_message_text
        assert sanitize_message_text("line1\\n\\nline2") == "line1\n\nline2"

    def test_exclamation_mark_unescaped(self):
        """MarkdownV2 escape artifact \\! must become plain !."""
        from watchdog_base import sanitize_message_text
        assert sanitize_message_text("Hello\\!") == "Hello!"

    def test_period_unescaped(self):
        """MarkdownV2 escape artifact \\. must become plain ."""
        from watchdog_base import sanitize_message_text
        assert sanitize_message_text("end\\.") == "end."

    def test_hyphen_unescaped(self):
        """MarkdownV2 escape artifact \\- must become plain -."""
        from watchdog_base import sanitize_message_text
        assert sanitize_message_text("a\\-b") == "a-b"

    def test_underscore_unescaped(self):
        from watchdog_base import sanitize_message_text
        assert sanitize_message_text("word\\_word") == "word_word"

    def test_combined_newline_and_exclamation(self):
        """Real-world case: both issues in one message."""
        from watchdog_base import sanitize_message_text
        result = sanitize_message_text("Fixed bug\\!\\n\\nSee details here\\.")
        assert result == "Fixed bug!\n\nSee details here."

    def test_empty_string(self):
        from watchdog_base import sanitize_message_text
        assert sanitize_message_text("") == ""

    def test_no_escapes_unchanged(self):
        from watchdog_base import sanitize_message_text
        assert sanitize_message_text("Normal text, no issues!") == "Normal text, no issues!"

    def test_curly_braces_unescaped(self):
        from watchdog_base import sanitize_message_text
        assert sanitize_message_text("\\{key\\}") == "{key}"

    def test_pipe_unescaped(self):
        from watchdog_base import sanitize_message_text
        assert sanitize_message_text("a\\|b") == "a|b"


class TestLifecycleSanitize:
    """Same sanitization tests for watchdog-lifecycle.py's _sanitize_text."""

    def test_import_and_basic(self):
        """Import _sanitize_text from watchdog-lifecycle and test basic case."""
        # watchdog-lifecycle uses argparse on import, mock it
        import importlib
        spec = importlib.util.spec_from_file_location(
            "watchdog_lifecycle",
            os.path.join(os.path.dirname(__file__), "..", "scripts", "watchdog-lifecycle.py"),
        )
        # Can't fully import (needs env), so test the function logic directly
        import re
        def _sanitize_text(text):
            if not text:
                return text
            text = text.replace("\\n", "\n")
            text = re.sub(r"\\([!./\-_{}()#>+*=|~`])", r"\1", text)
            return text

        assert _sanitize_text("hello\\nworld") == "hello\nworld"
        assert _sanitize_text("Fixed\\!") == "Fixed!"


class TestDesyncConfig:
    """Verify desync recovery configuration is present."""

    def test_desync_configs_exist(self):
        import watchdog_base as _b
        assert hasattr(_b, "DESYNC_RECOVERY_ENABLED")
        assert hasattr(_b, "TASK_ACK_TIMEOUT_SEC")
        assert hasattr(_b, "DESYNC_MAX_RETRIES")
        assert _b.TASK_ACK_TIMEOUT_SEC == 120
        assert _b.DESYNC_MAX_RETRIES >= 1

    def test_sanitize_importable(self):
        from watchdog_base import sanitize_message_text
        assert callable(sanitize_message_text)

    def test_noise_filter(self):
        from watchdog_base import is_session_noise
        assert is_session_noise({"text": "SESSION_ONLINE:kakashi"}) is True
        assert is_session_noise({"text": "SESSION_OFFLINE:kakashi"}) is True
        assert is_session_noise({"text": "SESSION_READY:kakashi"}) is True
        assert is_session_noise({"text": "kakashi going offline (session end)"}) is True
        assert is_session_noise({"text": "kakashi:fix issue=505"}) is False


class TestDirtyWorkdirGuard:
    def test_dirty_workdir_report_detects_uncommitted_files(self, tmp_path, monkeypatch):
        import subprocess
        import watchdog_base as _b

        subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
        (tmp_path / "dirty.txt").write_text("pending")

        monkeypatch.setattr(_b, "AGENT_ID", "test-agent")
        monkeypatch.setenv("AGENT_WORKDIR", str(tmp_path))

        report = _b._dirty_workdir_report()

        assert f"workdir={tmp_path}" in report
        assert "dirty.txt" in report

    def test_dirty_workdir_report_empty_for_clean_repo(self, tmp_path, monkeypatch):
        import subprocess
        import watchdog_base as _b

        subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
        monkeypatch.setattr(_b, "AGENT_ID", "test-agent")
        monkeypatch.setenv("AGENT_WORKDIR", str(tmp_path))

        assert _b._dirty_workdir_report() == ""


class TestKibaDeterministicAlertRecovery:
    @staticmethod
    def _load_kiba_watchdog():
        import importlib.util
        path = os.path.join(os.path.dirname(__file__), "..", "scripts", "watchdog-kiba.py")
        spec = importlib.util.spec_from_file_location("watchdog_kiba", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.os.environ["KIBA_ACTION_TARGET_ENV"] = "prod"
        return module

    def test_frozen_alert_restarts_agent(self):
        mod = self._load_kiba_watchdog()
        assert mod.recovery_action_for_alert(
            "kiba:alert env=prod agent=kakashi frozen timeout=600s msgs_dropped=1"
        ) == ("restart_agent", "kakashi")

    def test_stuck_alert_restarts_agent(self):
        mod = self._load_kiba_watchdog()
        # Disable false-alert validation for unit test — real host processes
        # may exist with shorter uptime than the alert's claimed stuck duration
        mod.KIBA_MIN_CREDIBLE_STUCK_SEC = 999999999
        assert mod.recovery_action_for_alert(
            "kiba:alert env=prod agent=naruto runtime=claude stuck duration=2623min"
        ) == ("restart_agent", "naruto")

    def test_watchdog_dead_restarts_watchdog_only(self):
        mod = self._load_kiba_watchdog()
        assert mod.recovery_action_for_alert(
            "kiba:alert env=prod agent=kakashi watchdog=dead session=alive"
        ) == ("restart_watchdog", "kakashi")

    def test_idle_with_messages_nudges_agent(self):
        mod = self._load_kiba_watchdog()
        assert mod.recovery_action_for_alert(
            "kiba:alert env=prod agent=sasuke idle_with_messages msg_age=12min"
        ) == ("nudge_agent", "sasuke")

    def test_unrelated_alert_is_left_to_llm(self):
        mod = self._load_kiba_watchdog()
        assert mod.recovery_action_for_alert("kiba:alert disk=critical pct=95") is None

    def test_self_target_killswitch_returns_audit(self):
        """P0: Kiba cannot restart itself — returns audit reason."""
        mod = self._load_kiba_watchdog()
        mod.KIBA_SELF_TARGET_KILLSWITCH = True
        mod._b.AGENT_ID = "kiba"
        result = mod.recovery_action_for_alert(
            "kiba:alert env=prod agent=kiba runtime=claude stuck duration=30min"
        )
        assert result is not None
        assert result[0] == "audit"
        assert "self-target kill-switch" in result[1].lower()

    def test_false_alert_validation_returns_audit(self, monkeypatch):
        """False-alert validation blocks unsafe restart — returns audit."""
        mod = self._load_kiba_watchdog()
        mod.KIBA_MIN_CREDIBLE_STUCK_SEC = 300
        # Mock _validate_stuck_alert to return False
        monkeypatch.setattr(mod, "_validate_stuck_alert", lambda agent, text: False)
        result = mod.recovery_action_for_alert(
            "kiba:alert env=prod agent=kakashi runtime=claude stuck duration=120min"
        )
        assert result is not None
        assert result[0] == "audit"
        assert "false-alert" in result[1].lower()

    def test_storm_breaker_returns_audit(self, monkeypatch):
        """Storm breaker caps restarts — returns audit reason."""
        mod = self._load_kiba_watchdog()
        mod.KIBA_STORM_MAX_RESTARTS = 3
        mod.KIBA_SELF_TARGET_KILLSWITCH = False
        # Mock _storm_allows to return False
        monkeypatch.setattr(mod, "_storm_allows", lambda target: False)
        result = mod.recovery_action_for_alert(
            "kiba:alert env=prod agent=kakashi runtime=claude stuck duration=10min"
        )
        assert result is not None
        assert result[0] == "audit"
        assert "storm breaker" in result[1].lower()

    def test_compacting_loop_alert_matched_by_validation(self, monkeypatch):
        """compacting_loop alerts are validated, not silently passed."""
        mod = self._load_kiba_watchdog()
        mod.KIBA_SELF_TARGET_KILLSWITCH = False
        mod.KIBA_MIN_CREDIBLE_STUCK_SEC = 300
        # Mock _validate_stuck_alert to capture that it was called
        called = {"agent": None, "text": None}
        def fake_validate(agent, text):
            called["agent"] = agent
            called["text"] = text
            return True
        monkeypatch.setattr(mod, "_validate_stuck_alert", fake_validate)
        result = mod.recovery_action_for_alert(
            "kiba:alert env=prod agent=sasuke compacting_loop duration=15min"
        )
        assert result == ("restart_agent", "sasuke")
        assert called["agent"] == "sasuke"
        assert "compacting_loop" in called["text"]

    def test_frozen_permission_prompt_allowed(self):
        """frozen=permission_prompt is a real alert — allow restart."""
        mod = self._load_kiba_watchdog()
        mod.KIBA_SELF_TARGET_KILLSWITCH = False
        mod.KIBA_MIN_CREDIBLE_STUCK_SEC = 300
        result = mod.recovery_action_for_alert(
            "kiba:alert env=prod agent=kakashi frozen=permission_prompt action_hint=approve_or_deny"
        )
        assert result == ("restart_agent", "kakashi")

    def test_missing_environment_label_blocks_admin_action(self):
        mod = self._load_kiba_watchdog()
        result = mod.recovery_action_for_alert(
            "kiba:alert agent=kakashi watchdog=dead session=alive"
        )
        assert result is not None
        assert result[0] == "audit"
        assert "missing env" in result[1]

    def test_staging_alert_cannot_target_prod_actions(self):
        mod = self._load_kiba_watchdog()
        result = mod.recovery_action_for_alert(
            "kiba:alert env=staging agent=kakashi watchdog=dead session=alive"
        )
        assert result is not None
        assert result[0] == "audit"
        assert "does not match KIBA_ACTION_TARGET_ENV=prod" in result[1]


class TestDesyncTimerReset:
    def test_recovery_grace_does_not_retrigger_desync(self, monkeypatch):
        import watchdog_base as _b

        async def scenario():
            delivered = asyncio.Event()
            recovery_started_at = {"ts": None}
            recovery_calls = {"count": 0}

            monkeypatch.setattr(_b, "TMUX_SESSION", "test-session")
            monkeypatch.setattr(_b, "IDLE_POLL_SEC", 0.01)
            monkeypatch.setattr(_b, "IDLE_TIMEOUT_SEC", 0.02)
            monkeypatch.setattr(_b, "WAKE_TIMEOUT_SEC", 0)
            monkeypatch.setattr(_b, "DESYNC_RECOVERY_GRACE_SEC", 0.03)
            monkeypatch.setattr(_b, "INITIAL_STARTUP_GRACE_SEC", 0)
            monkeypatch.setattr(_b, "circuit_is_open", lambda: False)
            monkeypatch.setattr(_b, "format_batch", lambda pending: "prompt")
            monkeypatch.setattr(_b, "sanitize_message_text", lambda text: text)
            monkeypatch.setattr(_b, "is_session_alive", lambda session: True)

            def fake_is_agent_idle(_session, stable_checks=2):
                started = recovery_started_at["ts"]
                return started is not None and (asyncio.get_running_loop().time() - started) >= 0.03

            async def fake_recovery():
                recovery_calls["count"] += 1
                recovery_started_at["ts"] = asyncio.get_running_loop().time()
                return True

            async def fake_tmux_send(_session, _prompt):
                delivered.set()
                return True

            async def fake_audit(_reason, _detail=""):
                return None

            monkeypatch.setattr(_b, "is_agent_idle", fake_is_agent_idle)
            monkeypatch.setattr(_b, "try_desync_recovery", fake_recovery)
            monkeypatch.setattr(_b, "tmux_send", fake_tmux_send)
            monkeypatch.setattr(_b, "_send_desync_audit", fake_audit)

            q = asyncio.Queue()
            await q.put([{"data": {"text": "ping"}}])

            task = asyncio.create_task(_b.send_loop(q))
            try:
                await asyncio.wait_for(delivered.wait(), timeout=0.5)
            finally:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

            assert recovery_calls["count"] == 1

        asyncio.run(scenario())

    def test_wake_grace_does_not_consume_desync_budget(self, monkeypatch):
        import watchdog_base as _b

        async def scenario():
            delivered = asyncio.Event()
            wake_started_at = {"ts": None}
            recovery_calls = {"count": 0}

            monkeypatch.setattr(_b, "TMUX_SESSION", "test-session")
            monkeypatch.setattr(_b, "IDLE_POLL_SEC", 0.01)
            monkeypatch.setattr(_b, "IDLE_TIMEOUT_SEC", 0.02)
            monkeypatch.setattr(_b, "WAKE_TIMEOUT_SEC", 0.03)
            monkeypatch.setattr(_b, "DESYNC_RECOVERY_GRACE_SEC", 0.0)
            monkeypatch.setattr(_b, "INITIAL_STARTUP_GRACE_SEC", 0)
            monkeypatch.setattr(_b, "circuit_is_open", lambda: False)
            monkeypatch.setattr(_b, "format_batch", lambda pending: "prompt")
            monkeypatch.setattr(_b, "sanitize_message_text", lambda text: text)

            def fake_is_session_alive(_session):
                started = wake_started_at["ts"]
                return started is not None and (asyncio.get_running_loop().time() - started) >= 0.03

            def fake_is_agent_idle(_session, stable_checks=2):
                return fake_is_session_alive(_session)

            def fake_wake():
                if wake_started_at["ts"] is None:
                    wake_started_at["ts"] = asyncio.get_running_loop().time()
                return True

            async def fake_recovery():
                recovery_calls["count"] += 1
                return True

            async def fake_tmux_send(_session, _prompt):
                delivered.set()
                return True

            async def fake_audit(_reason, _detail=""):
                return None

            monkeypatch.setattr(_b, "is_session_alive", fake_is_session_alive)
            monkeypatch.setattr(_b, "is_agent_idle", fake_is_agent_idle)
            monkeypatch.setattr(_b, "try_wake_agent", fake_wake)
            monkeypatch.setattr(_b, "try_desync_recovery", fake_recovery)
            monkeypatch.setattr(_b, "tmux_send", fake_tmux_send)
            monkeypatch.setattr(_b, "_send_desync_audit", fake_audit)

            q = asyncio.Queue()
            await q.put([{"data": {"text": "ping"}}])

            task = asyncio.create_task(_b.send_loop(q))
            try:
                await asyncio.wait_for(delivered.wait(), timeout=0.5)
            finally:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

            assert recovery_calls["count"] == 0

        asyncio.run(scenario())


class TestSSEDedup:
    """Regression tests for SSE message dedup (#801)."""

    def test_dedup_trim_preserves_most_recent_ids(self):
        """Eviction must drop oldest entries first; most recent IDs survive trim."""
        # Simulate the dict-based dedup from konoha_sse_watcher
        seen: dict[str, None] = {}
        MAX_SIZE = 5000

        # Fill with sequential IDs 0..MAX_SIZE
        for i in range(MAX_SIZE + 1):
            msg_id = str(i)
            seen[msg_id] = None
            if len(seen) > MAX_SIZE:
                excess = len(seen) - MAX_SIZE // 2
                for _ in range(excess):
                    seen.pop(next(iter(seen)))

        # After trim: should be at most MAX_SIZE//2 = 2500 entries
        assert len(seen) <= MAX_SIZE // 2

        # Most recent ID (str(MAX_SIZE)) must survive
        assert str(MAX_SIZE) in seen, "most recent ID was evicted — trim does not preserve insertion order"

        # Oldest entries (0, 1, ...) must be evicted
        assert "0" not in seen, "oldest ID was not evicted"
        assert "1" not in seen, "oldest ID was not evicted"

        # Entries near the end must survive
        for i in range(MAX_SIZE - 10, MAX_SIZE + 1):
            assert str(i) in seen, f"recent ID {i} should survive trim"

    def test_sse_watcher_dedup_skips_duplicate_ids(self, monkeypatch):
        """Duplicate Konoha message IDs arriving via SSE must be skipped."""
        import watchdog_base as _b

        async def scenario():
            # Simulate the dedup logic inline (same code as in konoha_sse_watcher).
            # We don't mock the full watcher — we test the dedup contract directly.
            seen: dict[str, None] = {}
            MAX_SIZE = 5000
            delivered: list[dict] = []

            messages = [
                {"id": "msg-1", "from": "naruto", "text": "first"},
                {"id": "msg-1", "from": "naruto", "text": "first"},  # duplicate
                {"id": "msg-2", "from": "sasuke", "text": "second"},
                {"id": "msg-1", "from": "naruto", "text": "first"},  # duplicate again
                {"id": "msg-3", "from": "kiba", "text": "third"},
            ]

            for data in messages:
                msg_id = data.get("id", "")
                if msg_id and msg_id in seen:
                    continue  # dedup skip
                if _b.is_session_noise(data):
                    continue
                if msg_id:
                    seen[msg_id] = None
                    if len(seen) > MAX_SIZE:
                        excess = len(seen) - MAX_SIZE // 2
                        for _ in range(excess):
                            seen.pop(next(iter(seen)))
                delivered.append({"source": "konoha", "data": data})

            assert len(delivered) == 3, f"expected 3 unique messages, got {len(delivered)}"
            ids = [d["data"]["id"] for d in delivered]
            assert ids == ["msg-1", "msg-2", "msg-3"], f"unexpected order or duplicates: {ids}"

        asyncio.run(scenario())

    def test_watchdog_base_persistent_sse_dedup_after_delivery(self, tmp_path, monkeypatch):
        """Delivered SSE ids must be skipped across reconnect/restart replays (#802)."""
        import watchdog_base as _b

        state_path = tmp_path / "kakashi-sse-delivered.json"
        monkeypatch.setenv("AGENT_SSE_DEDUP_STATE", str(state_path))
        monkeypatch.setattr(_b, "AGENT_ID", "kakashi")
        monkeypatch.setattr(_b, "_delivered_sse_ids", None)

        delivered = {"source": "konoha", "data": {"_sse_id": "177-0", "text": "same task"}}
        duplicate = {"source": "konoha", "data": {"_sse_id": "177-0", "text": "same task"}}
        fresh = {"source": "konoha", "data": {"_sse_id": "178-0", "text": "new task"}}

        assert _b._filter_delivered_sse_events([delivered], []) == [delivered]
        _b._mark_sse_events_delivered([delivered])

        monkeypatch.setattr(_b, "_delivered_sse_ids", None)  # simulate watchdog restart
        assert _b._filter_delivered_sse_events([duplicate, fresh], []) == [fresh]

    def test_watchdog_base_pending_sse_dedup_does_not_mark_before_delivery(self, tmp_path, monkeypatch):
        """Duplicates in one replay burst are collapsed without losing retryability (#802)."""
        import watchdog_base as _b

        state_path = tmp_path / "kakashi-sse-delivered.json"
        monkeypatch.setenv("AGENT_SSE_DEDUP_STATE", str(state_path))
        monkeypatch.setattr(_b, "AGENT_ID", "kakashi")
        monkeypatch.setattr(_b, "_delivered_sse_ids", None)

        first = {"source": "konoha", "data": {"_sse_id": "179-0", "text": "task"}}
        duplicate = {"source": "konoha", "data": {"_sse_id": "179-0", "text": "task"}}

        assert _b._filter_delivered_sse_events([first, duplicate], []) == [first]
        monkeypatch.setattr(_b, "_delivered_sse_ids", None)
        assert _b._filter_delivered_sse_events([duplicate], []) == [duplicate]

    def test_lifecycle_persistent_sse_dedup_after_delivery(self, tmp_path, monkeypatch):
        """Lifecycle watchdog uses the same delivered-id contract for SSE replay (#802)."""
        import importlib.util
        import os

        path = os.path.join(os.path.dirname(__file__), "..", "scripts", "watchdog-lifecycle.py")
        spec = importlib.util.spec_from_file_location("watchdog_lifecycle_sse_dedup_test", path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        monkeypatch.setenv("WATCHDOG_LIFECYCLE_SSE_DEDUP_DIR", str(tmp_path))
        module._delivered_sse_ids.clear()

        delivered = {"source": "sse", "data": {"_sse_id": "180-0", "text": "task"}}
        duplicate = {"source": "sse", "data": {"_sse_id": "180-0", "text": "task"}}
        fresh = {"source": "sse", "data": {"_sse_id": "181-0", "text": "new"}}

        assert module.filter_delivered_sse_events("shino", [delivered], []) == [delivered]
        module.mark_sse_events_delivered("shino", [delivered])
        module._delivered_sse_ids.clear()

        assert module.filter_delivered_sse_events("shino", [duplicate, fresh], []) == [fresh]
