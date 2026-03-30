#!/usr/bin/env python3
"""
Mirai Bitrix24 Poller — sales monitor for coMind
Usage:
  bitrix-poller.py digest   — morning digest (run at 9:00)
  bitrix-poller.py monitor  — change monitoring (run every 2h, 9-19)
  bitrix-poller.py pings    — proactive next-touch pings (run at 9:30)
  bitrix-poller.py daily    — 9:50 MSK: digest + personalized next-step pings (working days only)
"""
import sys
import json
import os
import requests
from datetime import datetime, date, timedelta
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

BITRIX_URL = "https://knwlab.bitrix24.ru/rest/1/dbobwawe33pb31jl"
KONOHA_URL = "http://127.0.0.1:3200"
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")
SNAPSHOTS_DIR = Path("/opt/shared/mirai/snapshots")
SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)

YEGOR_CHAT_ID = "93791246"        # Telegram ID Егора
SASHA_CHAT_ID = "75397531"        # Telegram ID Саши (Александр Макаров)
COMIND_LEADS_CHAT_ID = "-4982206077"  # Группа coMind Лиды

TG_SEND_SCRIPT = "/home/ubuntu/tg-send-user.py"

# Bitrix24 user ID → salesperson mapping
# TODO: verify IDs — webhook /rest/1/ = admin account, real user IDs differ
# To find your Bitrix ID: open Bitrix24 → your profile URL contains /user/ID/
SALES_PERSONS = {
    # bitrix_id: {tg_id, username}
    # Filled with observed ASSIGNED_BY_IDs from deals: 1, 17, 19, 25
    # Need Yegor and Sasha to confirm which is which
    "1":  {"name": "Егор",  "tg_id": None,         "username": "@yegor_aprelsky"},  # admin/system
    "17": {"name": "?",     "tg_id": None,         "username": None},
    "19": {"name": "?",     "tg_id": None,         "username": None},
    "25": {"name": "?",     "tg_id": None,         "username": None},
}

# Stage names (main pipeline CATEGORY_ID=0)
STAGE_NAMES = {
    "PREPARATION": "Неразобранное",
    "UC_X0AW1T": "Первичный контакт",
    "UC_YKWSWB": "Выявление потребности",
    "UC_EJQDRV": "Содержательное предложение",
    "UC_745K2M": "Коммерческое предложение",
    "UC_5UIHPA": "КП отправлено",
    "NEW": "Ожидание",
    "UC_1SYSJG": "Согласование договора",
    "EXECUTING": "Реализация",
    "WON": "Успешно реализовано",
    "LOSE": "Закрыто",
}

# Per-stage "next touch date" custom fields
STAGE_NEXT_TOUCH = {
    "PREPARATION": "UF_CRM_1751545446871",
    "UC_X0AW1T":  "UF_CRM_1751615886049",
    "UC_YKWSWB":  "UF_CRM_1751615926730",
    "UC_EJQDRV":  "UF_CRM_1751615955705",
    "UC_745K2M":  "UF_CRM_1751615989341",
    "UC_5UIHPA":  "UF_CRM_1751616016688",
    "NEW":        "UF_CRM_1751616046053",
    "UC_1SYSJG":  "UF_CRM_1751616102343",
    "EXECUTING":  "UF_CRM_1751616131019",
}

ALL_NEXT_TOUCH_FIELDS = list(STAGE_NEXT_TOUCH.values())

# Active stage semantic IDs (P = in progress)
ACTIVE_SEMANTIC = {"P"}

# Stages to skip in monitoring (won/lost/executing)
CLOSED_STAGES = {"WON", "LOSE", "EXECUTING"}

STALE_DAYS = 14  # days without stage change = stale

# ── Bitrix24 API ──────────────────────────────────────────────────────────────

def bx(method, params=None):
    """Call Bitrix24 REST API."""
    url = f"{BITRIX_URL}/{method}"
    r = requests.get(url, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json().get("result", [])


def get_all_deals():
    """Fetch all active deals (in-progress stages) from main pipeline."""
    select = [
        "ID", "TITLE", "STAGE_ID", "STAGE_SEMANTIC_ID", "OPPORTUNITY",
        "CURRENCY_ID", "DATE_MODIFY", "DATE_CREATE", "MOVED_TIME",
        "ASSIGNED_BY_ID", "CONTACT_ID", "COMPANY_ID", "COMMENTS",
    ] + ALL_NEXT_TOUCH_FIELDS

    deals = []
    start = 0
    while True:
        params = {
            "filter[STAGE_SEMANTIC_ID]": "P",
            "filter[CATEGORY_ID]": "0",
            "start": start,
        }
        for i, f in enumerate(select):
            params[f"select[{i}]"] = f

        data = bx("crm.deal.list", params)
        if not data:
            break
        deals.extend(data)
        if len(data) < 50:
            break
        start += 50

    return deals


def get_deal_comments(deal_id, limit=5):
    """Get recent timeline comments for a deal."""
    try:
        result = bx("crm.timeline.comment.list", {
            "filter[ENTITY_TYPE]": "deal",
            "filter[ENTITY_ID]": deal_id,
            "order[ID]": "desc",
            "select[0]": "ID",
            "select[1]": "ENTITY_ID",
            "select[2]": "COMMENT",
            "select[3]": "CREATED",
        })
        return result[:limit] if result else []
    except Exception:
        return []


def fmt_amount(opp, currency="RUB"):
    try:
        v = float(opp)
        if v == 0:
            return "—"
        return f"{v:,.0f} {currency}".replace(",", " ")
    except Exception:
        return "—"


def parse_date(s):
    """Parse Bitrix24 date string to date object."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s).date()
    except Exception:
        return None


def get_next_touch(deal):
    """Return the relevant next-touch date for this deal's stage."""
    stage = deal.get("STAGE_ID", "")
    field = STAGE_NEXT_TOUCH.get(stage)
    if not field:
        return None
    return parse_date(deal.get(field))


def stage_name(stage_id):
    return STAGE_NAMES.get(stage_id, stage_id)


# ── Snapshots ─────────────────────────────────────────────────────────────────

def save_snapshot(deals):
    path = SNAPSHOTS_DIR / "latest.json"
    path_prev = SNAPSHOTS_DIR / "prev.json"
    if path.exists():
        path.rename(path_prev)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(deals, f, ensure_ascii=False, indent=2)


def load_snapshot(name="latest.json"):
    path = SNAPSHOTS_DIR / name
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return {d["ID"]: d for d in data}


def compute_diff(prev_map, curr_map):
    """Return dict with new/changed/removed deals."""
    diff = {"new": [], "stage_change": [], "amount_change": [], "new_comments": []}

    for did, deal in curr_map.items():
        if did not in prev_map:
            diff["new"].append(deal)
            continue
        old = prev_map[did]

        if deal.get("STAGE_ID") != old.get("STAGE_ID"):
            diff["stage_change"].append({
                "deal": deal,
                "old_stage": old.get("STAGE_ID"),
                "new_stage": deal.get("STAGE_ID"),
            })

        old_opp = float(old.get("OPPORTUNITY", 0) or 0)
        new_opp = float(deal.get("OPPORTUNITY", 0) or 0)
        if abs(old_opp - new_opp) > 0.01 and (old_opp > 0 or new_opp > 0):
            diff["amount_change"].append({
                "deal": deal,
                "old_amount": old_opp,
                "new_amount": new_opp,
            })

    return diff


# ── Messaging ─────────────────────────────────────────────────────────────────

def send_konoha(to, text, msg_type="message"):
    """Send message via Konoha bus."""
    headers = {"Authorization": f"Bearer {KONOHA_TOKEN}", "Content-Type": "application/json"}
    payload = {"from": "mirai", "to": to, "type": msg_type, "text": text}
    try:
        r = requests.post(f"{KONOHA_URL}/messages", json=payload, headers=headers, timeout=10)
        return r.ok
    except Exception:
        return False


def send_telegram(chat_id, text):
    """Send Telegram message via tg-send.py (Naruto bot)."""
    import subprocess, shlex
    try:
        result = subprocess.run(
            ["python3", TG_SEND_SCRIPT, str(chat_id), text],
            capture_output=True, text=True, timeout=15
        )
        return result.returncode == 0
    except Exception as e:
        print(f"[tg-send error] {e}")
        return False


def send_alert(text, to_group=True):
    """Send alert. Digests go to coMind Лиды group; monitors/pings to Yegor personally."""
    if to_group:
        send_telegram(COMIND_LEADS_CHAT_ID, text)
    else:
        send_telegram(YEGOR_CHAT_ID, text)


# ── Function 1: Morning Digest ─────────────────────────────────────────────────

def run_digest():
    today = date.today()
    deals = get_all_deals()
    save_snapshot(deals)

    # Only main pipeline deals (no C5: prefix), excluding closed/executing
    main_deals = [d for d in deals if not d["STAGE_ID"].startswith("C") and d["STAGE_ID"] not in CLOSED_STAGES]

    no_amount = []
    stale = []
    no_touch = []
    overdue = []
    by_stage = {}
    pipeline_total = 0.0

    for deal in main_deals:
        stage = deal["STAGE_ID"]
        if stage in CLOSED_STAGES:
            continue

        opp = float(deal.get("OPPORTUNITY") or 0)
        pipeline_total += opp

        by_stage.setdefault(stage, {"count": 0, "total": 0.0})
        by_stage[stage]["count"] += 1
        by_stage[stage]["total"] += opp

        if opp == 0:
            no_amount.append(deal)

        moved = parse_date(deal.get("MOVED_TIME") or deal.get("DATE_MODIFY"))
        if moved and (today - moved).days > STALE_DAYS:
            stale.append((deal, (today - moved).days))

        touch = get_next_touch(deal)
        if not touch:
            no_touch.append(deal)
        elif touch < today:
            overdue.append((deal, touch))
        elif touch == today:
            overdue.append((deal, touch))  # due today counts as overdue in digest

    lines = [f"📊 Дайджест воронки — {today.strftime('%d.%m.%Y')}"]
    lines.append(f"\nВсего активных сделок: {len(main_deals)}")
    lines.append(f"Сумма воронки: {fmt_amount(pipeline_total)}\n")

    lines.append("По стадиям:")
    for stage_id in ["PREPARATION","UC_X0AW1T","UC_YKWSWB","UC_EJQDRV","UC_745K2M","UC_5UIHPA","NEW","UC_1SYSJG"]:
        s = by_stage.get(stage_id)
        if s and s["count"] > 0:
            lines.append(f"  {stage_name(stage_id)}: {s['count']} шт, {fmt_amount(s['total'])}")

    if no_amount:
        lines.append(f"\n⚠️ Без суммы ({len(no_amount)}):")
        for d in no_amount[:10]:
            lines.append(f"  • {d['TITLE'][:45]} [{stage_name(d['STAGE_ID'])}]")

    if stale:
        lines.append(f"\n🕰 Стадия не менялась >{STALE_DAYS} дн ({len(stale)}):")
        for d, days in stale[:10]:
            lines.append(f"  • {d['TITLE'][:40]} — {days} дн [{stage_name(d['STAGE_ID'])}]")

    if overdue:
        lines.append(f"\n🔴 Просроченные касания ({len(overdue)}):")
        for d, touch in overdue[:10]:
            lines.append(f"  • {d['TITLE'][:40]} — план {touch.strftime('%d.%m')}")

    if no_touch:
        lines.append(f"\n❓ Нет даты след. касания ({len(no_touch)}):")
        for d in no_touch[:10]:
            lines.append(f"  • {d['TITLE'][:45]}")

    text = "\n".join(lines)
    send_alert(text, to_group=True)
    print(text)


# ── Function 2: Change Monitoring ─────────────────────────────────────────────

def run_monitor():
    deals = get_all_deals()
    curr_map = {d["ID"]: d for d in deals if d["STAGE_ID"] not in CLOSED_STAGES}
    prev_map = load_snapshot("latest.json")

    diff = compute_diff(prev_map, curr_map)
    save_snapshot(deals)

    lines = []

    if diff["new"]:
        lines.append(f"🆕 Новые сделки ({len(diff['new'])}):")
        for d in diff["new"]:
            lines.append(f"  • {d['TITLE'][:50]} [{stage_name(d['STAGE_ID'])}] {fmt_amount(d.get('OPPORTUNITY',0))}")

    if diff["stage_change"]:
        lines.append(f"\n🔄 Смена стадии ({len(diff['stage_change'])}):")
        for ch in diff["stage_change"]:
            d = ch["deal"]
            lines.append(f"  • {d['TITLE'][:40]}: {stage_name(ch['old_stage'])} → {stage_name(ch['new_stage'])}")

    if diff["amount_change"]:
        lines.append(f"\n💰 Изменение суммы ({len(diff['amount_change'])}):")
        for ch in diff["amount_change"]:
            d = ch["deal"]
            lines.append(f"  • {d['TITLE'][:40]}: {fmt_amount(ch['old_amount'])} → {fmt_amount(ch['new_amount'])}")

    if not lines:
        print("No changes detected.")
        return

    lines.insert(0, f"📡 Изменения в воронке — {datetime.now().strftime('%d.%m %H:%M')}")
    text = "\n".join(lines)
    send_alert(text, to_group=True)
    print(text)


# ── Function 3: Proactive Pings ───────────────────────────────────────────────

def run_pings():
    today = date.today()
    tomorrow = today + timedelta(days=1)
    deals = get_all_deals()

    main_deals = [d for d in deals if not d["STAGE_ID"].startswith("C")]

    overdue = []
    due_today = []
    due_tomorrow = []

    for deal in main_deals:
        stage = deal["STAGE_ID"]
        if stage in CLOSED_STAGES:
            continue
        touch = get_next_touch(deal)
        if not touch:
            continue
        if touch < today:
            overdue.append((deal, touch))
        elif touch == today:
            due_today.append((deal, touch))
        elif touch == tomorrow:
            due_tomorrow.append((deal, touch))

    lines = []

    if overdue:
        lines.append(f"🔴 Просроченные касания ({len(overdue)}):")
        for d, t in overdue:
            lines.append(f"  • {d['TITLE'][:45]} — было {t.strftime('%d.%m')} [{stage_name(d['STAGE_ID'])}]")

    if due_today:
        lines.append(f"\n🟡 Касания сегодня ({len(due_today)}):")
        for d, t in due_today:
            lines.append(f"  • {d['TITLE'][:45]} [{stage_name(d['STAGE_ID'])}]")

    if due_tomorrow:
        lines.append(f"\n🔔 Завтра ({len(due_tomorrow)}):")
        for d, t in due_tomorrow:
            lines.append(f"  • {d['TITLE'][:45]} [{stage_name(d['STAGE_ID'])}]")

    if not lines:
        print("No upcoming touch dates.")
        return

    lines.insert(0, f"📌 Пинги по касаниям — {today.strftime('%d.%m.%Y')}")
    text = "\n".join(lines)
    send_alert(text, to_group=True)
    print(text)


# ── Production Calendar ───────────────────────────────────────────────────────

def is_working_day(dt: date) -> bool:
    """Check Russian production calendar via isdayoff.ru. Falls back to weekday check."""
    try:
        r = requests.get(
            "https://isdayoff.ru/api/getdata",
            params={"year": dt.year, "month": dt.month, "day": dt.day, "cc": "ru"},
            timeout=5,
        )
        return r.text.strip() == "0"
    except Exception as e:
        print(f"[production-calendar] API error: {e}, falling back to weekday check")
        return dt.weekday() < 5  # Mon–Fri


# ── Function 4: Daily 9:50 digest + personalized pings ────────────────────────

def get_today_activities():
    """Get Bitrix24 activities (tasks) due today for leads and deals."""
    today = date.today()
    today_str = today.strftime("%Y-%m-%dT00:00:00")
    tomorrow_str = (today + timedelta(days=1)).strftime("%Y-%m-%dT00:00:00")

    items = []
    start = 0
    while True:
        params = {
            "filter[>=DEADLINE]": today_str,
            "filter[<DEADLINE]": tomorrow_str,
            "filter[COMPLETED]": "N",
            "select[0]": "ID", "select[1]": "SUBJECT", "select[2]": "ENTITY_TYPE_ID",
            "select[3]": "ENTITY_ID", "select[4]": "RESPONSIBLE_ID", "select[5]": "DEADLINE",
            "start": start,
        }
        data = bx("crm.activity.list", params)
        if not data:
            break
        items.extend(data)
        if len(data) < 50:
            break
        start += 50
    return items


def get_all_leads():
    """Fetch active leads from Bitrix24."""
    leads = []
    start = 0
    while True:
        params = {
            "filter[STATUS_SEMANTIC_ID]": "P",
            "select[0]": "ID", "select[1]": "TITLE", "select[2]": "ASSIGNED_BY_ID",
            "select[3]": "STATUS_ID", "select[4]": "DATE_MODIFY",
            "start": start,
        }
        data = bx("crm.lead.list", params)
        if not data:
            break
        leads.extend(data)
        if len(data) < 50:
            break
        start += 50
    return leads


def resolve_salesperson(assigned_id: str) -> dict | None:
    """Return salesperson info or None if unknown/unassigned."""
    # Direct match by explicit mapping
    # Yegor
    if assigned_id in ("93791246",):
        return {"name": "Егор", "tg_id": YEGOR_CHAT_ID, "username": "@yegor_aprelsky"}
    # Sasha
    if assigned_id in ("75397531",):
        return {"name": "Саша", "tg_id": SASHA_CHAT_ID, "username": "@Ctrain2042"}
    # Bitrix user ID mapping (to be verified by Yegor)
    sp = SALES_PERSONS.get(assigned_id)
    if sp and sp.get("tg_id"):
        return sp
    return None


def run_daily():
    """9:50 MSK — working days only: digest to group + personalized next-step pings."""
    today = date.today()

    if not is_working_day(today):
        print(f"[daily] Not a working day: {today}, skipping.")
        return

    print(f"[daily] Working day confirmed: {today}")

    # 1. Send digest to group
    run_digest()

    # 2. Collect items with next_touch == today from deals
    deals = get_all_deals()
    main_deals = [d for d in deals if not d["STAGE_ID"].startswith("C") and d["STAGE_ID"] not in CLOSED_STAGES]

    deal_pings = []  # (entity_label, assigned_id, title, stage)
    for deal in main_deals:
        touch = get_next_touch(deal)
        if touch == today:
            deal_pings.append({
                "type": "Сделка",
                "title": deal.get("TITLE", ""),
                "stage": stage_name(deal.get("STAGE_ID", "")),
                "assigned_id": deal.get("ASSIGNED_BY_ID", ""),
            })

    # 3. Collect leads with activities due today
    activities = get_today_activities()
    leads_map = {l["ID"]: l for l in get_all_leads()}
    lead_pings = []
    for act in activities:
        # ENTITY_TYPE_ID=1 = lead, 2 = deal
        if str(act.get("ENTITY_TYPE_ID")) == "1":
            lead_id = str(act.get("ENTITY_ID", ""))
            lead = leads_map.get(lead_id, {})
            lead_pings.append({
                "type": "Лид",
                "title": lead.get("TITLE") or act.get("SUBJECT") or f"Лид #{lead_id}",
                "stage": lead.get("STATUS_ID", ""),
                "assigned_id": lead.get("ASSIGNED_BY_ID") or act.get("RESPONSIBLE_ID", ""),
            })

    all_pings = deal_pings + lead_pings

    if not all_pings:
        print("[daily] No next-step items today.")
        return

    # 4. Group by salesperson
    for_yegor = []
    for_sasha = []
    for_group = []

    for item in all_pings:
        aid = str(item.get("assigned_id", ""))
        sp = resolve_salesperson(aid)
        if sp and sp["name"] == "Егор":
            for_yegor.append(item)
        elif sp and sp["name"] == "Саша":
            for_sasha.append(item)
        else:
            for_group.append(item)

    def fmt_item(item):
        return f"  {item['title'][:50]} [{item['stage']}]" if item.get("stage") else f"  {item['title'][:55]}"

    # Send to Yegor personally
    if for_yegor:
        lines = [f"Привет! Сегодня {today.strftime('%d.%m')} срок следующего шага по:"]
        for item in for_yegor:
            lines.append(fmt_item(item))
        send_telegram(YEGOR_CHAT_ID, "\n".join(lines))

    # Send to Sasha personally
    if for_sasha:
        lines = [f"Привет! Сегодня {today.strftime('%d.%m')} срок следующего шага по:"]
        for item in for_sasha:
            lines.append(fmt_item(item))
        send_telegram(SASHA_CHAT_ID, "\n".join(lines))

    # Send to group with @mentions
    if for_group:
        lines = [f"@yegor_aprelsky @Ctrain2042 сегодня {today.strftime('%d.%m')} срок следующего шага по:"]
        for item in for_group:
            lines.append(fmt_item(item))
        send_telegram(COMIND_LEADS_CHAT_ID, "\n".join(lines))

    total = len(for_yegor) + len(for_sasha) + len(for_group)
    print(f"[daily] Sent pings: Yegor={len(for_yegor)}, Sasha={len(for_sasha)}, group={len(for_group)}, total={total}")


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "digest"

    # Load env
    env_file = Path(os.environ.get("HOME", "/home/ubuntu")) / ".agent-env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("KONOHA_TOKEN="):
                KONOHA_TOKEN = line.split("=", 1)[1].strip().strip('"')
            if line.startswith("SASHA_CHAT_ID="):
                SASHA_CHAT_ID = line.split("=", 1)[1].strip().strip('"')

    if mode == "digest":
        run_digest()
    elif mode == "monitor":
        run_monitor()
    elif mode == "pings":
        run_pings()
    elif mode == "daily":
        run_daily()
    else:
        print(f"Unknown mode: {mode}. Use: digest | monitor | pings | daily")
        sys.exit(1)
