#!/bin/bash
# preview-reap.sh — tear down previews for closed/merged PRs.
# A merged PR's preview is done by definition: stop its truss-pr@N service
# (the unit's ExecStopPost runs tilt down + removes the worktree), and remove
# orphaned worktrees whose service isn't running.
# Runs from cron; cheap when there's nothing to do.
set -u
cd /home/ubuntu/projects/truss || exit 1

declare -A STATE
while read -r n s; do STATE[$n]=$s; done < <(gh pr list --repo roowus/truss --state all --limit 200 --json number,state --jq '.[] | "\(.number) \(.state)"' 2>/dev/null)

reaped=0
# 1. running services for closed/merged PRs
for unit in $(systemctl list-units --all "truss-pr@*" --no-pager --plain 2>/dev/null | awk '$4=="running" {print $1}'); do
  n=${unit#truss-pr@}; n=${n%.service}
  case "${STATE[$n]:-}" in
    MERGED|CLOSED)
      echo "$(date -Is) reaping preview for PR $n (state ${STATE[$n]})"
      sudo -n systemctl stop "truss-pr@$n" && reaped=$((reaped+1))
      # retitle the worker session [merged] — it is idle by now
      SID=$(python3 -c "
import json, sys
try:
    for e in json.load(open('$HOME/.local/state/truss-sessions.json')):
        if str(e.get('pr')) == '$n': print(e['session']); break
except Exception: pass
" 2>/dev/null)
      if [ -n "$SID" ]; then
        TITLE=$(python3 -c "
import json
for e in json.load(open('$HOME/.local/state/truss-sessions.json')):
    if str(e.get('pr')) == '$n':
        print('work: #%s [merged]' % e.get('issue')); break
")
        curl -sS -m 5 -X POST http://127.0.0.1:3080/plugins/dsh-spawn/title           -H 'content-type: application/json'           -d "{"sessionId": "$SID", "title": "$TITLE"}" >/dev/null 2>&1 &&           echo "$(date -Is) retitled $SID -> $TITLE"
      fi
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
      git worktree remove --force "$wt" 2>/dev/null && reaped=$((reaped+1)) || true
      ;;
  esac
done

[ "$reaped" -gt 0 ] && echo "$(date -Is) reaped $reaped"
exit 0
