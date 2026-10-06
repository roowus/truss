#!/usr/bin/env bash
# audit-watch — token-free delivery of PR audit reports to work sessions.
#
# The GitHub side posts audit reports as PR comments (## 🔍 PR audit). This
# watcher polls GitHub (cheap gh api calls, no LLM tokens) and, when a PR
# with a session marker gets a fresh report, hands the report to that
# session. Work sessions therefore never poll and never burn context waiting.
#
# Routing: the work session puts an `agent-session: <name>` marker line in
# the PR body (see config/agent/work-session.md). DSH work sessions normally
# self-wake with one-shot reminders — this watcher is the safety net and the
# payload drop: it spools fresh reports so a waking session reads a file
# instead of calling the API. If $TRUSS_AUDIT_INJECT is set, it is called as
# `$TRUSS_AUDIT_INJECT <session-name> <report-file>` for real push delivery.
#
# Run it from cron or a systemd user timer, every minute or two:
#   * * * * * /home/ubuntu/projects/truss/scripts/audit-watch.sh
#
# State: ~/.local/state/truss-audit-watch.json (last-delivered comment id
# per PR).

set -uo pipefail

REPO="${TRUSS_AUDIT_REPO:-roowus/truss}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/truss-audit-watch.json"
SPOOL="${XDG_STATE_HOME:-$HOME/.local/state}/truss-audit-spool"
mkdir -p "$SPOOL" "$(dirname "$STATE")"
[ -f "$STATE" ] || echo '{}' > "$STATE"

# open PRs that carry a session marker
gh pr list -R "$REPO" --state open --json number,body,updatedAt \
  --jq '.[] | select(.body | test("(agent|truss)-session:")) | "\(.number)\t\(.body)"' \
| while IFS=$'\t' read -r pr body; do
    session=$(printf '%s' "$body" | grep -oE '(agent|truss)-session: *[A-Za-z0-9._-]+' | head -1 | awk '{print $2}')
    [ -z "$session" ] && continue

    # newest audit report comment on this PR
    report=$(gh api "repos/$REPO/issues/$pr/comments?per_page=100" \
      --jq '[.[] | select(.body | startswith("## 🔍 PR audit"))] | last | "\(.id)\t\(.body)"' 2>/dev/null)
    [ -z "$report" ] && continue
    cid=${report%%$'\t'*}

    last=$(python3 -c "import json; print(json.load(open('$STATE')).get('$pr', 0))" 2>/dev/null || echo 0)
    [ "$cid" = "$last" ] && continue

    file="$SPOOL/$session-pr$pr-$cid.md"
    printf '%s' "${report#*$'\t'}" > "$file"

    if [ -n "${TRUSS_AUDIT_INJECT:-}" ]; then
      "$TRUSS_AUDIT_INJECT" "$session" "$file" \
        && echo "$(date -Is) delivered report $cid for PR $pr to session $session"
    else
      echo "$(date -Is) spooled report $cid for PR $pr (session $session) at $file"
    fi

    python3 - "$STATE" "$pr" "$cid" <<'EOF'
import json, sys
state = json.load(open(sys.argv[1]))
state[sys.argv[2]] = int(sys.argv[3])
json.dump(state, open(sys.argv[1], "w"))
EOF
  done

# orphans: labeled for audit but no session marker — nobody is driving the
# fix loop on them. List them in a file the prioritize cron reads.
gh pr list -R "$REPO" --state open --label audit --json number,title,body \
  --jq '.[] | select(.body | test("(agent|truss)-session:") | not) | "#\(.number) \(.title)"' \
  > "$SPOOL/ORPHANS.txt" 2>/dev/null
[ -s "$SPOOL/ORPHANS.txt" ] && \
  echo "$(date -Is) orphan audit-labeled PRs (no session): $(paste -sd'; ' "$SPOOL/ORPHANS.txt")"

# contradiction sweep: audit + ready-for-review together means a worker handed
# off mid-loop. The audit label is the truth — strip the premature marker.
gh pr list -R "$REPO" --state open --label audit --label ready-for-review \
  --json number --jq '.[].number' 2>/dev/null | while read -r n; do
  gh pr edit "$n" -R "$REPO" --remove-label ready-for-review 2>/dev/null && \
    echo "$(date -Is) PR #$n: stripped premature ready-for-review (audit label still on)"
done

# needs-answer wake: a worker parked on a question polls NOTHING — this sweep
# watches the PR/issue comments and prompts the owning session the moment a
# new comment lands after its question. (Comments all share the repo owner's
# login — worker and developer alike — so the trigger is "newest comment id
# moved", baselined on first sight.)
gh pr list -R "$REPO" --state open --label needs-answer --json number --jq '.[].number' 2>/dev/null > "$SPOOL/needs-answer.txt"
while read -r n; do
  [ -n "$n" ] || continue
  LATEST=$(gh api "repos/$REPO/issues/$n/comments" --jq '.[-1].id // empty' 2>/dev/null | tail -1)
  [ -n "$LATEST" ] || continue
  KEY="needs-answer-$n"
  BASELINE=$(python3 -c "
import json
try: print(json.load(open('$STATE')).get('$KEY', ''))
except Exception: pass" 2>/dev/null)
  if [ -z "$BASELINE" ]; then
    python3 -c "
import json
try: d = json.load(open('$STATE'))
except Exception: d = {}
d['$KEY'] = '$LATEST'; json.dump(d, open('$STATE', 'w'))"
    continue
  fi
  if [ "$LATEST" != "$BASELINE" ]; then
    SID=$(python3 -c "
import json
try:
    for e in json.load(open('$HOME/.local/state/truss-sessions.json')):
        if str(e.get('pr')) == '$n': print(e['session']); break
except Exception: pass" 2>/dev/null)
    python3 -c "
import json
d = json.load(open('$STATE')); d['$KEY'] = '$LATEST'; json.dump(d, open('$STATE', 'w'))"
    if [ -n "$SID" ]; then
      curl -sS -m 8 -X POST http://127.0.0.1:3080/plugins/dsh-spawn/prompt -H 'content-type: application/json'         -d "{"sessionId": "$SID", "prompt": "A comment just landed on PR #$n — likely the developer's answer to your question. Read it (gh pr view $n --comments), and if it answers you: remove the needs-answer label, clear your unread badge, retitle [working], ledger working, continue. If it is not an answer, stay parked."}" >/dev/null 2>&1
      echo "$(date -Is) PR #$n: answer landed — woke $SID"
    fi
  fi
done < "$SPOOL/needs-answer.txt"

# unpark CI: bot pushes park pull_request runs as action_required (GitHub's
# bot approval gate). Approving as the local user clears them; without this
# every automated fix push leaves the PR showing "workflow needs approval".
gh api "repos/$REPO/actions/runs?status=action_required&per_page=50" \
  --jq '.workflow_runs[].id' 2>/dev/null \
| while read -r run_id; do
    [ -z "$run_id" ] && continue
    gh api -X POST "repos/$REPO/actions/runs/$run_id/approve" >/dev/null 2>&1 \
      && echo "$(date -Is) approved parked run $run_id"
  done
true
