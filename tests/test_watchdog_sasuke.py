import asyncio
import importlib.util
import os
from contextlib import suppress


def _load_watchdog_sasuke():
    path = os.path.join(os.path.dirname(__file__), "..", "scripts", "watchdog-sasuke.py")
    spec = importlib.util.spec_from_file_location("watchdog_sasuke_test", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class _DummyRedis:
    async def xadd(self, *args, **kwargs):
        return None


def test_sasuke_send_loop_honors_recovery_grace(monkeypatch):
    module = _load_watchdog_sasuke()

    async def scenario():
        delivered = asyncio.Event()
        recovery_started_at = {"ts": None}
        recovery_calls = {"count": 0}

        monkeypatch.setattr(module.aioredis, "Redis", lambda *args, **kwargs: _DummyRedis())
        monkeypatch.setattr(module._b, "TMUX_SESSION", "sasuke-test")
        monkeypatch.setattr(module._b, "IDLE_POLL_SEC", 0.01)
        monkeypatch.setattr(module._b, "IDLE_TIMEOUT_SEC", 0.02)
        monkeypatch.setattr(module._b, "DESYNC_RECOVERY_GRACE_SEC", 0.03)

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

        async def fake_mark_read(_events, _rd):
            return None

        async def fake_audit(_reason, _detail=""):
            return None

        monkeypatch.setattr(module._b, "is_agent_idle", fake_is_agent_idle)
        monkeypatch.setattr(module._b, "try_desync_recovery", fake_recovery)
        monkeypatch.setattr(module._b, "tmux_send", fake_tmux_send)
        monkeypatch.setattr(module._b, "_send_desync_audit", fake_audit)
        monkeypatch.setattr(module, "_mark_read_telegram", fake_mark_read)

        q = asyncio.Queue()
        await q.put([{"source": "telegram", "data": {"text": "ping", "chat_id": "1", "msg_id": "2"}}])

        task = asyncio.create_task(module.send_loop(q))
        try:
            await asyncio.wait_for(delivered.wait(), timeout=0.5)
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

        assert recovery_calls["count"] == 1

    asyncio.run(scenario())
