import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from telegram_sales_router import (  # noqa: E402
    build_case_args,
    classify_sales_event,
    dedup_key,
    process_event,
)


def test_router_route_lead_starts_sales_workflow_payload():
    event = {
        "chat_id": "-531788843",
        "chat_title": "coMind",
        "msg_id": "42",
        "sender_name": "Client",
        "text": "Нужен AI-ассистент для обработки заявок и подготовки КП",
        "router_route": "lead",
        "router_confidence": "0.91",
        "router_reason": "commercial request",
    }

    classification = classify_sales_event(event)
    args = build_case_args(event, classification)

    assert classification == {"classification": "sales_lead", "reason": "router_route:lead"}
    assert args["process_id"] == "lead-qualification"
    assert args["subject"].startswith("Telegram lead:")
    assert args["payload"]["sales_classification"] == "sales_lead"
    assert args["payload"]["raw_message"].startswith("Нужен AI-ассистент")
    assert args["payload"]["source_agent"] == "sasuke"


def test_sales_chat_keyword_detects_lead_without_llm_route():
    event = {
        "chat_id": "-4982206077",
        "chat_title": "coMind Лиды",
        "msg_id": "43",
        "text": "Клиент просит оценку проекта и коммерческое предложение",
        "router_route": "none",
        "action_hint": "observe",
    }

    assert classify_sales_event(event) == {
        "classification": "sales_lead",
        "reason": "sales_chat_keyword",
    }


def test_non_sales_chat_does_not_start_case():
    event = {
        "chat_id": "-531788843",
        "chat_title": "coMind",
        "msg_id": "44",
        "text": "Спасибо, понял",
        "router_route": "none",
    }

    assert classify_sales_event(event)["classification"] != "sales_lead"


def test_dedup_key_is_stable_for_chat_message():
    event = {"chat_id": "-4982206077", "msg_id": "99", "text": "lead"}

    assert dedup_key(event) == dedup_key(event)
    assert dedup_key(event).endswith(":-4982206077:99")


class FakeRedis:
    def __init__(self):
        self.keys = set()
        self.audit = []
        self.acked = []
        self.deleted = []

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.keys:
            return False
        self.keys.add(key)
        return True

    def delete(self, key):
        self.deleted.append(key)

    def xadd(self, stream, data, maxlen=None, approximate=None):
        self.audit.append((stream, data))
        return "audit-1"

    def xack(self, stream, group, entry_id):
        self.acked.append((stream, group, entry_id))


def test_process_event_starts_case_and_audits_lead(monkeypatch):
    started = []

    def fake_start_sales_case(args):
        started.append(args)
        return {"ok": True, "data": {"case_id": "case-1", "process_id": args["process_id"]}}

    monkeypatch.setattr("telegram_sales_router.start_sales_case", fake_start_sales_case)
    r = FakeRedis()

    process_event(r, "1-0", {
        "chat_id": "-4982206077",
        "chat_title": "coMind Лиды",
        "msg_id": "100",
        "text": "Клиент просит оценку проекта и КП",
        "router_route": "lead",
        "router_confidence": "0.9",
    })

    assert len(started) == 1
    assert started[0]["process_id"] == "lead-qualification"
    assert started[0]["payload"]["source_agent"] == "sasuke"
    assert r.audit[-1][1]["result"] == "case_started"
    assert r.audit[-1][1]["case_id"] == "case-1"
    assert r.acked == [("telegram:log", "sales-router", "1-0")]


def test_process_event_does_not_start_case_for_non_sales(monkeypatch):
    started = []
    monkeypatch.setattr("telegram_sales_router.start_sales_case", lambda args: started.append(args))
    r = FakeRedis()

    process_event(r, "1-1", {
        "chat_id": "-531788843",
        "chat_title": "coMind",
        "msg_id": "101",
        "text": "Спасибо, понял",
        "router_route": "none",
    })

    assert started == []
    assert r.audit[-1][1]["classification"] != "sales_lead"
    assert r.acked == [("telegram:log", "sales-router", "1-1")]
