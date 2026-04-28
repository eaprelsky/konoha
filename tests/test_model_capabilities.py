import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from model_capabilities import (  # noqa: E402
    CAP_TEXT,
    CAP_VISION,
    apply_capability_fields,
    capability_decision,
    model_capabilities,
)


def test_deepseek_profile_is_text_only_for_vision_routing():
    caps = model_capabilities("deepseek-v4-pro")
    assert CAP_TEXT in caps
    assert CAP_VISION not in caps


def test_photo_event_routes_to_vision_stream_when_target_lacks_vision(monkeypatch):
    monkeypatch.delenv("KONOHA_AGENT_SASUKE_MODEL", raising=False)
    event = {"attachment_kind": "photo", "attachment_path": "/tmp/image.jpg"}

    decision = capability_decision(event, "sasuke")

    assert decision["target_agent"] == "sasuke"
    assert decision["target_model"] == "deepseek-v4-pro"
    assert decision["required_capabilities"] == "text,vision"
    assert decision["missing_capabilities"] == "vision"
    assert decision["target_stream"] == "telegram:vision_requests"


def test_text_event_routes_to_default_incoming_stream():
    event = {"text": "hello"}

    decision = capability_decision(event, "sasuke")

    assert decision["required_capabilities"] == "text"
    assert decision["missing_capabilities"] == ""
    assert decision["target_stream"] == "telegram:incoming"


def test_agent_model_override_can_enable_vision(monkeypatch):
    monkeypatch.setenv("KONOHA_AGENT_SASUKE_MODEL", "google/gemini-2.0-flash-lite-001")
    event = {"attachment_kind": "photo", "attachment_path": "/tmp/image.jpg"}

    decision = capability_decision(event, "sasuke")

    assert decision["missing_capabilities"] == ""
    assert decision["target_stream"] == "telegram:incoming"


def test_apply_capability_fields_mutates_event():
    event = {"attachment_kind": "photo", "attachment_path": "/tmp/image.jpg"}

    decision = apply_capability_fields(event, "sasuke")

    assert event["missing_capabilities"] == "vision"
    assert event["target_stream"] == decision["target_stream"]
