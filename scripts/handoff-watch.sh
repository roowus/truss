#!/bin/bash
# handoff-watch — enforce the ready-handoff message contract.
# Spec (config/agent/work-session.md phase 3 step 4c): every [ready] handoff
# message in the session must carry the PR link, the preview link, the
# original-issue link + restatement, and concrete test steps. Most workers
# skip it when unprompted, so this watcher reads the last assistant message
# of every ledger session in state "review" and orders a repost when the kit
# is incomplete. Fires once per handoff (keyed on the message timestamp).
set -u
exec python3 - "$@" <<'EOF'
import glob, json, os, re, subprocess, sys, urllib.request

LEDGER = os.path.expanduser("~/.local/state/truss-sessions.json")
STATE = os.path.expanduser("~/.local/state/truss-handoff-watch.json")

def last_assistant_text(session_id):
    paths = glob.glob(f"/opt/dsh/sessions/*/{session_id}/session.v4.jsonl.zstd")
    if not paths:
        return None, 0
    try:
        raw = subprocess.run(["zstd", "-dc", paths[0]], capture_output=True, timeout=30).stdout.decode()
    except Exception:
        return None, 0
    last_time, texts = 0, []
    for line in raw.splitlines():
        if '"role":"assistant"' not in line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        t = ev.get("time", 0)
        if t < last_time:
            continue
        msg = ev.get("data", {}).get("message", {})
        parts = msg.get("content", [])
        text = " ".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("type") == "text")
        if text.strip():
            if t > last_time:
                last_time, texts = t, [text]
            else:
                texts.append(text)
    return (" ".join(texts) if texts else None), last_time

def prompt(session_id, text):
    req = urllib.request.Request(
        "http://127.0.0.1:3080/plugins/dsh-spawn/prompt",
        data=json.dumps({"sessionId": session_id, "prompt": text}).encode(),
        headers={"content-type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=8)
        return True
    except Exception:
        return False

try:
    ledger = json.load(open(LEDGER))
except Exception:
    sys.exit(0)
try:
    seen = json.load(open(STATE))
except Exception:
    seen = {}

for e in ledger:
    if e.get("state") != "review":
        continue
    sid, pr, issue = e.get("session"), e.get("pr"), e.get("issue")
    if not sid or not pr:
        continue
    text, mtime = last_assistant_text(sid)
    if not text or not mtime:
        continue
    key = f"{sid}:{mtime}"
    if seen.get(sid) == key:
        continue  # already judged this exact handoff message
    missing = []
    if f"github.com/roowus/truss/pull/{pr}" not in text:
        missing.append(f"the PR link (https://github.com/roowus/truss/pull/{pr})")
    if f"pr-{pr}.truss.rewis" not in text:
        missing.append(f"the preview link (https://pr-{pr}.truss.rewis)")
    if issue and f"/issues/{issue}" not in text:
        missing.append(f"the original-issue link (https://github.com/roowus/truss/issues/{issue}) + its one-sentence restatement")
    if not re.search(r"\b(to test|how to test|steps?|try (it|this|opening))\b", text, re.I):
        missing.append("concrete test steps for the issue's own ask")
    seen[sid] = key
    if missing:
        ok = prompt(sid,
            "Your ready handoff message was incomplete. Per work-session.md phase 3 step 4c, "
            "post the complete ready message in this session NOW, including: "
            + "; ".join(missing)
            + ". The full kit, verbatim URLs, every handoff.")
        print(f"{sid[:24]} pr#{pr}: missing {len(missing)} element(s) -> repost ordered ({'sent' if ok else 'SEND FAILED'})", flush=True)
    else:
        print(f"{sid[:24]} pr#{pr}: handoff complete", flush=True)

json.dump(seen, open(STATE, "w"))
EOF
