#!/usr/bin/env python3
"""
QA Watcher — monitors GitHub Issues for bugs closed with 'awaiting-test' label,
then immediately pings Hinata via Konoha to run tests.

Polls every 60 seconds. Tracks already-notified issues in a state file to avoid
duplicate pings.
"""
import json
import os
import time
import subprocess
import logging
from pathlib import Path

GH_TOKEN_FILE = os.path.expanduser("~/.github-token")
REPO = "eaprelsky/konoha"
KONOHA_URL = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")
STATE_FILE = "/tmp/qa-watcher-notified.json"
POLL_INTERVAL = 60  # seconds

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("/tmp/qa-watcher.log"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)


def load_notified() -> set:
    try:
        with open(STATE_FILE) as f:
            return set(json.load(f))
    except Exception:
        return set()


def save_notified(notified: set) -> None:
    with open(STATE_FILE, "w") as f:
        json.dump(list(notified), f)


def gh(args: list[str]) -> list[dict]:
    token = Path(GH_TOKEN_FILE).read_text().strip()
    env = {**os.environ, "GH_TOKEN": token}
    result = subprocess.run(
        ["gh"] + args,
        capture_output=True, text=True, env=env, timeout=30,
    )
    if result.returncode != 0:
        log.warning(f"gh error: {result.stderr[:200]}")
        return []
    return json.loads(result.stdout) if result.stdout.strip() else []


def send_to_hinata(issue_number: int, issue_title: str) -> None:
    payload = json.dumps({
        "from": "qa-watcher",
        "to": "hinata",
        "text": f"hinata:test issue={issue_number} title={json.dumps(issue_title)}",
    })
    env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
    result = subprocess.run(
        [
            "curl", "-s", "-X", "POST",
            "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
            "-H", "Content-Type: application/json",
            "-d", payload,
            f"{KONOHA_URL}/messages",
        ],
        capture_output=True, text=True, env=env, timeout=10,
    )
    if result.returncode == 0:
        log.info(f"Pinged Hinata for issue #{issue_number}: {issue_title}")
    else:
        log.error(f"Failed to ping Hinata: {result.stderr[:100]}")


def check_once(notified: set) -> None:
    issues = gh([
        "issue", "list",
        "--repo", REPO,
        "--state", "closed",
        "--label", "awaiting-test",
        "--json", "number,title,labels,closedAt",
        "--limit", "50",
    ])
    for issue in issues:
        num = issue["number"]
        if num in notified:
            continue
        title = issue.get("title", "")
        log.info(f"New awaiting-test issue found: #{num} {title}")
        send_to_hinata(num, title)
        notified.add(num)
    save_notified(notified)


def main() -> None:
    log.info("QA Watcher starting — polling every 60s for awaiting-test closed issues")
    notified = load_notified()
    while True:
        try:
            check_once(notified)
        except Exception as e:
            log.error(f"check_once error: {e}")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
