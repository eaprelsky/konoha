import importlib.util
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))


def load_script_module(name: str, filename: str):
    path = SCRIPT_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_context_packer_treats_empty_stream_batch_as_idle():
    module = load_script_module("telegram_context_packer_idle", "telegram-context-packer.py")

    assert module._has_items([]) is False
    assert module._has_items([("telegram:needs_context", [])]) is False
    assert module._has_items([("telegram:needs_context", [("1-0", {"text": "hi"})])]) is True


def test_context_packer_detects_stale_event_by_original_timestamp(monkeypatch):
    module = load_script_module("telegram_context_packer_stale_timestamp", "telegram-context-packer.py")
    monkeypatch.setattr(module, "MAX_EVENT_AGE_SEC", 1800)

    is_stale, age_sec = module._is_stale_event(
        "1779090959082-0",
        {"timestamp": "2026-05-05T12:56:08+00:00"},
        now=1779091200.0,
    )

    assert is_stale is True
    assert age_sec > 1800


def test_context_packer_accepts_recent_event_by_original_timestamp(monkeypatch):
    module = load_script_module("telegram_context_packer_recent_timestamp", "telegram-context-packer.py")
    monkeypatch.setattr(module, "MAX_EVENT_AGE_SEC", 1800)

    is_stale, age_sec = module._is_stale_event(
        "1779090959082-0",
        {"timestamp": "2026-05-18T07:55:00+00:00"},
        now=1779091200.0,
    )

    assert is_stale is False
    assert age_sec == 300.0


def test_vision_packer_treats_empty_stream_batch_as_idle():
    module = load_script_module("telegram_vision_packer_idle", "telegram-vision-packer.py")

    assert module._has_items([]) is False
    assert module._has_items([("telegram:vision_requests", [])]) is False
    assert module._has_items([("telegram:vision_requests", [("1-0", {"attachment_path": "/tmp/a.png"})])]) is True
