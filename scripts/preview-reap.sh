#!/bin/bash
# preview-reap.sh — tear down previews for closed/merged PRs and retitle
# their worker sessions.
# A merged PR's preview is done by definition: stop its truss-pr@N service
# (the unit's ExecStopPost runs tilt down + removes the worktree), remove
# orphaned worktrees whose service isn't running, and flip the worker
# session's title bracket to [merged] — for EVERY merged PR with a ledger
# entry, whether or not it still had preview artifacts (a session-spawned
# tilt stack dies with dsh restarts and leaves no service to stop).
# Runs from cron; cheap when there's nothing to do.
set -u
cd /home/ubuntu/projects/truss || exit 1
LEDGER="$HOME/.local/state/truss-sessions.json"

declare -A STATE
while read -r n s; do STATE[$n]=$s; done < <(gh pr list --repo roowus/truss --state all --limit 200 --json number,state --jq '.[] | "\(.number) \(.state)"' 2>/dev/null)

# retitle <pr> <bracket>: flip the worker session's title via dsh-spawn.
retitle() {
  local n=$1 bracket=$2
  local SID TITLE PRTITLE
  SID=$(python3 -c "
import json
try:
    for e in json.load(open('$LEDGER')):
        if str(e.get('pr')) == '$n': print(e['session']); break
except Exception: pass
" 2>/dev/null)
  [ -n "$SID" ] || return 0
  PRTITLE=$(gh pr view "$n" -R roowus/truss --json title --jq .title 2>/dev/null | cut -c1-50)
  TITLE="#$n [$bracket]${PRTITLE:+ — $PRTITLE}"
  python3 - "$SID" "$TITLE" <<'EOF'
import json, sys, urllib.request
req = urllib.request.Request(
    "http://127.0.0.1:3080/plugins/dsh-spawn/title",
    data=json.dumps({"sessionId": sys.argv[1], "title": sys.argv[2]}).encode(),
    headers={"content-type": "application/json"}, method="POST")
try:
    urllib.request.urlopen(req, timeout=5)
except Exception:
    pass
EOF
  echo "$(date -Is) retitled ${SID:0:24} -> $TITLE"
}

reaped=0
# 1. running services for closed/merged PRs
for unit in $(systemctl list-units --all "truss-pr@*" --no-pager --plain 2>/dev/null | awk '$4=="running" {print $1}'); do
  n=${unit#truss-pr@}; n=${n%.service}
  case "${STATE[$n]:-}" in
    MERGED|CLOSED)
      echo "$(date -Is) reaping preview for PR $n (state ${STATE[$n]})"
      sudo -n systemctl stop "truss-pr@$n" && reaped=$((reaped+1))
      ;;
  esac
done

# 2. orphaned worktrees (no running service, PR closed/merged)
for wt in pr-preview/w/*/; do
  n=$(basename "$wt"); [[ "$n" =~ ^[0-9]+$ ]] || continue
  systemctl is-active --quiet "truss-pr@$n" && continue
  case "${STATE[$n]:-}" in
    MERGED|CLOSED)
      echo "$(date -Is) removing orphaned worktree w/$n"
      if git worktree remove --force "$wt" 2>/dev/null; then
        reaped=$((reaped+1))
      elif [ -d "$wt" ]; then
        # registration already gone (service teardown ran first); the dir is
        # stale files only — remove it directly, guarded to pr-preview/w/
        case "$(readlink -f "$wt")" in
          "$(readlink -f pr-preview/w)"/*) rm -rf "$wt" && reaped=$((reaped+1)) ;;
          *) echo "$(date -Is) REFUSED to remove unexpected path $wt" ;;
        esac
      fi
      ;;
  esac
done

# 3. merged-PR retitles — independent of whether any preview artifact
#    survived; the ledger is the source of truth for worker sessions
while read -r n; do
  [ -n "$n" ] || continue
  case "${STATE[$n]:-}" in
    MERGED) retitle "$n" merged ;;
    CLOSED) retitle "$n" closed ;;
    *) continue ;;
  esac
  # labels are pre-merge signals — they must not outlive the merge
  gh pr edit "$n" -R roowus/truss --remove-label ready-for-review --remove-label needs-answer 2>/dev/null || true
  # mark the ledger entry so this fires once
  python3 - "$LEDGER" "$n" <<'EOF'
import json, sys
p, n = sys.argv[1], sys.argv[2]
try:
    entries = json.load(open(p))
except Exception:
    sys.exit(0)
from datetime import datetime, timezone
for e in entries:
    if str(e.get("pr")) == n:
        e["state"] = "merged"
        e["mergedAt"] = datetime.now(timezone.utc).isoformat()
json.dump(entries, open(p, "w"), indent=1)
EOF
done < <(python3 -c "
import json
try:
    seen = set()
    for e in json.load(open('$LEDGER')):
        pr = e.get('pr')
        if pr and e.get('state') != 'merged' and pr not in seen:
            seen.add(pr); print(pr)
except Exception: pass
")

# 4. archive merged worker sessions idle over a week — the sidebar is a
#    workbench, not a museum; archive (not delete) keeps history recoverable.
#    The archive route REFUSES sessions with running work, so an active one
#    is safe by construction.
python3 - "$LEDGER" <<'EOF'
import json, sys, urllib.request
from datetime import datetime, timezone, timedelta
try:
    entries = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
cutoff = datetime.now(timezone.utc) - timedelta(days=7)
for e in entries:
    if e.get("state") != "merged" or e.get("archived"):
        continue
    stamp = e.get("mergedAt") or e.get("since")
    try:
        when = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except Exception:
        continue
    if when > cutoff:
        continue
    req = urllib.request.Request(
        "http://127.0.0.1:3080/plugins/dsh-spawn/archive",
        data=json.dumps({"sessionId": e["session"]}).encode(),
        headers={"content-type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=8)
        e["archived"] = True
        print(f"archived {e['session'][:24]} (merged {stamp})", flush=True)
    except urllib.error.HTTPError as err:
        if err.code != 409:  # 409 = still active; try again next week
            print(f"archive failed for {e['session'][:24]}: {err.code}", flush=True)
    except Exception:
        pass
json.dump(entries, open(sys.argv[1], "w"), indent=1)
EOF

[ "$reaped" -gt 0 ] && echo "$(date -Is) reaped $reaped"
exit 0
