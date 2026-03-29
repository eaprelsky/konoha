#!/usr/bin/env python3
"""
Watchdog checker — called as part of check_bus_and_konoha loop.
For each /tmp/watchdog-{agent}.txt file:
  - If agent posted SESSION_ONLINE after watchdog timestamp → confirmed, notify TG + cleanup
  - If elapsed > 180s with no confirmation → alert Yegor via TG + cleanup
"""
import os, sys, time, subprocess, glob, json
import urllib.request, urllib.error

KONOHA_URL = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")
TIMEOUT_SEC = 180
TG_SEND = "/home/ubuntu/tg-send.py"
YEGOR_ID = os.environ.get("OWNER_TG_ID", "")  # set in .owner-config


def konoha_get(path):
    req = urllib.request.Request(
        f"{KONOHA_URL}{path}",
        headers={"Authorization": f"Bearer {KONOHA_TOKEN}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"[watchdog] konoha GET {path} error: {e}", file=sys.stderr)
        return None


def tg_send(text):
    subprocess.run(["python3", TG_SEND, YEGOR_ID, text], capture_output=True)


def check():
    watchdog_files = glob.glob("/tmp/watchdog-*.txt")
    if not watchdog_files:
        return

    now = time.time()

    for wf in watchdog_files:
        agent = os.path.basename(wf).replace("watchdog-", "").replace(".txt", "")
        try:
            restart_ts = float(open(wf).read().strip())
        except Exception:
            os.remove(wf)
            continue

        elapsed = now - restart_ts

        # Check agent's lastHeartbeat via Konoha
        data = konoha_get(f"/agents/{agent}")
        if data:
            last_hb = data.get("lastHeartbeat", 0)
            # lastHeartbeat is milliseconds epoch
            if isinstance(last_hb, (int, float)):
                last_hb_sec = last_hb / 1000
                if last_hb_sec > restart_ts:
                    print(f"[watchdog] {agent} confirmed online (hb: {last_hb_sec:.0f} > restart: {restart_ts:.0f})")
                    tg_send(f"{agent} вернулся после перезапуска (heartbeat подтверждён)")
                    os.remove(wf)
                    continue

        if elapsed > TIMEOUT_SEC:
            print(f"[watchdog] {agent} did NOT come back in {TIMEOUT_SEC}s — alerting Yegor")
            tg_send(f"ВНИМАНИЕ: {agent} не поднялся после перезапуска ({int(elapsed)}с прошло). Проверь вручную.")
            os.remove(wf)
        else:
            print(f"[watchdog] {agent} not online yet, elapsed {int(elapsed)}s / {TIMEOUT_SEC}s")


if __name__ == "__main__":
    # Load agent env
    env_file = os.path.expanduser("~/.agent-env")
    if os.path.exists(env_file):
        for line in open(env_file):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                v = v.strip().strip('"').strip("'")
                os.environ.setdefault(k.strip(), v)
        KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")

    check()
