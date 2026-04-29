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
    def __init__(self):
        self.xadd_calls = []
        self.xack_calls = []

    async def xadd(self, *args, **kwargs):
        self.xadd_calls.append((args, kwargs))
        return None

    async def xack(self, *args, **kwargs):
        self.xack_calls.append((args, kwargs))
        return None


def test_sasuke_send_loop_honors_recovery_grace(monkeypatch):
    module = _load_watchdog_sasuke()

    async def scenario():
        delivered = asyncio.Event()
        recovery_started_at = {"ts": None}
        recovery_calls = {"count": 0}
        dummy_redis = _DummyRedis()

        monkeypatch.setattr(module.aioredis, "Redis", lambda *args, **kwargs: dummy_redis)
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


def test_sasuke_send_loop_does_not_mark_read_on_tmux_timeout(monkeypatch):
    module = _load_watchdog_sasuke()

    async def scenario():
        mark_read_calls = {"count": 0}
        delivered_attempts = {"count": 0}
        dummy_redis = _DummyRedis()

        monkeypatch.setattr(module.aioredis, "Redis", lambda *args, **kwargs: dummy_redis)
        monkeypatch.setattr(module._b, "TMUX_SESSION", "sasuke-test")
        monkeypatch.setattr(module._b, "IDLE_POLL_SEC", 0.01)
        monkeypatch.setattr(module._b, "is_agent_idle", lambda _session, stable_checks=2: True)

        async def fake_tmux_send(_session, _prompt):
            delivered_attempts["count"] += 1
            if delivered_attempts["count"] == 1:
                return False
            return True

        async def fake_mark_read(_events, _rd):
            mark_read_calls["count"] += 1

        monkeypatch.setattr(module._b, "tmux_send", fake_tmux_send)
        monkeypatch.setattr(module, "_mark_read_telegram", fake_mark_read)

        q = asyncio.Queue()
        await q.put([{
            "source": "telegram",
            "data": {"text": "ping", "chat_id": "1", "msg_id": "2"},
            "redis_id": "1710000000000-0",
        }])

        task = asyncio.create_task(module.send_loop(q))
        try:
            deadline = asyncio.get_running_loop().time() + 1.5
            while delivered_attempts["count"] < 2 and asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.01)
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

        assert delivered_attempts["count"] >= 2
        assert dummy_redis.xack_calls == [
            (("telegram:incoming", "sasuke", "1710000000000-0"), {})
        ]
        assert mark_read_calls["count"] == 1

    asyncio.run(scenario())


def test_sasuke_telegram_watcher_replays_pending_before_new_messages(monkeypatch):
    module = _load_watchdog_sasuke()

    class _ReplayRedis:
        def __init__(self):
            self.calls = []

        async def xgroup_create(self, *args, **kwargs):
            return None

        async def xreadgroup(self, _group, _consumer, streams, count=10, block=5000):
            stream_id = next(iter(streams.values()))
            self.calls.append(stream_id)
            if self.calls == ["0"]:
                return [(
                    module.TG_STREAM,
                    [("1710000000001-0", {"text": "pending", "chat_id": "1", "msg_id": "10"})],
                )]
            if self.calls == ["0", "0"]:
                return [(module.TG_STREAM, [])]
            if self.calls == ["0", "0", ">"]:
                return [(
                    module.TG_STREAM,
                    [("1710000000002-0", {"text": "new", "chat_id": "1", "msg_id": "11"})],
                )]
            await asyncio.sleep(3600)

        async def xack(self, *args, **kwargs):
            return None

        async def aclose(self):
            return None

    async def scenario():
        replay_redis = _ReplayRedis()
        monkeypatch.setattr(module.aioredis, "Redis", lambda *args, **kwargs: replay_redis)
        monkeypatch.setattr(module, "STALE_PENDING_MAX_AGE_SEC", 10**12)

        q = asyncio.Queue()
        task = asyncio.create_task(module.telegram_redis_watcher(q))
        try:
            first = await asyncio.wait_for(q.get(), timeout=0.5)
            second = await asyncio.wait_for(q.get(), timeout=0.5)
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

        assert first["data"]["text"] == "pending"
        assert first["redis_id"] == "1710000000001-0"
        assert second["data"]["text"] == "new"
        assert second["redis_id"] == "1710000000002-0"
        assert replay_redis.calls[:3] == ["0", "0", ">"]

    asyncio.run(scenario())
