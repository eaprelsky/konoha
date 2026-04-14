#!/usr/bin/env python3
import json
import os
import time
import urllib.request

KONOHA_URL = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200").rstrip("/")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")
WAIT_TIMEOUT_SEC = int(os.environ.get("AGENT_AUTOSTART_WAIT_TIMEOUT_SEC", "120"))
START_DELAY_SEC = float(os.environ.get("AGENT_AUTOSTART_DELAY_SEC", "2"))
BOOT_ORDER = ["naruto", "sasuke", "mirai", "kakashi", "kiba", "jiraiya"]


def request(path: str, method: str = "GET", body: dict | None = None):
    headers = {"Authorization": f"Bearer {KONOHA_TOKEN}"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(f"{KONOHA_URL}{path}", data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = resp.read().decode("utf-8")
        return json.loads(payload) if payload else None


def wait_for_konoha():
    deadline = time.time() + WAIT_TIMEOUT_SEC
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{KONOHA_URL}/health", timeout=5) as resp:
                if resp.status == 200:
                    return
        except Exception:
            pass
        time.sleep(2)
    raise SystemExit("Konoha API did not become healthy in time")


def main():
    if not KONOHA_TOKEN:
        raise SystemExit("KONOHA_TOKEN is required")

    wait_for_konoha()
    request("/admin/seed-system-agents", method="POST", body={})
    agents = request("/agents?online=false") or []
    by_id = {a.get("id"): a for a in agents if a.get("id")}

    targets = []
    for agent_id in BOOT_ORDER:
        agent = by_id.get(agent_id)
        if agent and "autostart" in (agent.get("tags") or []):
            targets.append(agent)

    for agent in sorted(agents, key=lambda a: a.get("id", "")):
        agent_id = agent.get("id")
        if not agent_id or agent_id in BOOT_ORDER:
            continue
        if "autostart" in (agent.get("tags") or []):
            targets.append(agent)

    for agent in targets:
        agent_id = agent["id"]
        request(f"/agents/{agent_id}/start", method="POST", body={})
        print(f"started {agent_id}")
        time.sleep(START_DELAY_SEC)


if __name__ == "__main__":
    main()
