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


def test_vision_packer_treats_empty_stream_batch_as_idle():
    module = load_script_module("telegram_vision_packer_idle", "telegram-vision-packer.py")

    assert module._has_items([]) is False
    assert module._has_items([("telegram:vision_requests", [])]) is False
    assert module._has_items([("telegram:vision_requests", [("1-0", {"attachment_path": "/tmp/a.png"})])]) is True
