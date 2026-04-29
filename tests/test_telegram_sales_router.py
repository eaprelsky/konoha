import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from telegram_sales_router import (  # noqa: E402
    build_case_args,
    classify_sales_event,
    dedup_key,
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
