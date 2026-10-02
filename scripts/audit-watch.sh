#!/usr/bin/env bash
# audit-watch — token-free delivery of PR audit reports to work sessions.
#
# The GitHub side posts audit reports as PR comments (## 🔍 PR audit). This
# watcher polls GitHub (cheap gh api calls, no LLM tokens) and, when a PR
# with a session marker gets a fresh report, hands the report to that
# session. Work sessions therefore never poll and never burn context waiting.
#
# Routing: the work session puts a `truss-session: <id>` marker line in the
# PR body (see config/agent/work-session.md). The watcher routes the report
# to that session via $TRUSS_AUDIT_INJECT, a command that receives the
# session id as $1 and the report file path as $2. Default: append the
# report to a spool file at ~/.local/state/truss-audit-spool/<id>.md for the
# session's next wake.
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
  --jq '.[] | select(.body | test("truss-session:")) | "\(.number)\t\(.body)"' \
| while IFS=$'\t' read -r pr body; do
    session=$(printf '%s' "$body" | grep -oE 'truss-session: *[A-Za-z0-9._-]+' | head -1 | awk '{print $2}')
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
