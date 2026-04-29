import importlib.util
import json
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "telegram-event-bridge.py"
spec = importlib.util.spec_from_file_location("telegram_event_bridge", MODULE_PATH)
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)


class FakeRedis:
    def __init__(self):
        self.audit = []
        self.dead = []
        self.acked = []

    def xadd(self, stream, data, maxlen=None, approximate=True):
        if stream == bridge.AUDIT_STREAM:
            self.audit.append(data)
        elif stream == bridge.DEAD_STREAM:
            self.dead.append(data)
        return "1-0"

    def xack(self, stream, group, entry_id):
        self.acked.append((stream, group, entry_id))


def test_builds_generic_message_event_payload():
    fields = {
        "chat_id": "-1001",
        "chat_title": "coMind Лиды",
        "msg_id": "42",
        "text": "Нужен AI ассистент",
    }

    assert bridge.event_type(fields) == "telegram.message.received"
    payload = bridge.event_payload("171-0", fields)

    assert payload["chat_title"] == "coMind Лиды"
    assert payload["telegram_stream"] == "telegram:log"
    assert payload["telegram_stream_id"] == "171-0"


def test_builds_generic_reaction_event_type():
    assert bridge.event_type({"new_reaction": "👍"}) == "telegram.reaction.received"


def test_process_entry_publishes_and_acks(monkeypatch):
    r = FakeRedis()
    published = []

    def fake_publish(entry_id, fields):
        published.append((entry_id, fields))
        return {"id": "evt-1", "cases_created": ["case-1"]}

    monkeypatch.setattr(bridge, "publish_event", fake_publish)

    bridge.process_entry(r, "1-0", {"chat_title": "coMind Лиды", "msg_id": "42"})

    assert published == [("1-0", {"chat_title": "coMind Лиды", "msg_id": "42"})]
    assert r.acked == [(bridge.STREAM, bridge.GROUP, "1-0")]
    assert r.audit[0]["result"] == "published"
    assert json.loads(r.audit[0]["cases_created"]) == ["case-1"]


def test_process_entry_dead_letters_and_acks_on_publish_error(monkeypatch):
    r = FakeRedis()

    def fail_publish(_entry_id, _fields):
        raise RuntimeError("boom")

    monkeypatch.setattr(bridge, "publish_event", fail_publish)

    try:
        bridge.process_entry(r, "1-1", {"chat_id": "-1001"})
    except RuntimeError:
        pass

    assert r.acked == [(bridge.STREAM, bridge.GROUP, "1-1")]
    assert r.dead[0]["result"] == "error"
    assert "RuntimeError" in r.dead[0]["error"]
