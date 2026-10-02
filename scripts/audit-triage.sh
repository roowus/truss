#!/usr/bin/env bash
# audit-triage — one-line status per open PR: verdict, C/H findings, ci,
# mergeable state, label. For driving the backlog burn-down.
set -uo pipefail
REPO="${1:-roowus/truss}"
printf "%-4s %-18s %-7s %-5s %-11s %s\n" PR VERDICT C/H CI MERGEABLE TITLE
for pr in $(gh pr list -R "$REPO" --state open --limit 50 --json number --jq '.[].number' | sort -n); do
  view=$(gh pr view "$pr" -R "$REPO" --json title,mergeable,statusCheckRollup,comments,labels 2>/dev/null)
  title=$(printf '%s' "$view" | jq -r '.title[0:38]')
  mergeable=$(printf '%s' "$view" | jq -r '.mergeable')
  ci=$(printf '%s' "$view" | jq -r '[.statusCheckRollup[]? | .conclusion // .status] | if length == 0 then "none" elif any(. == "FAILURE") then "FAIL" elif all(. == "SUCCESS") then "green" else "pending" end')
  verdict=$(printf '%s' "$view" | jq -r '[.comments[].body | select(contains("truss-audit-state"))] | last // "" | (capture("\\\\\"verdict\\\\\"[^\u0022]") // null)' 2>/dev/null)
  # simpler: pull verdict + counts from the last report's json block
  read -r verdict ch <<< "$(printf '%s' "$view" | python3 -c "
import json, re, sys
d = json.load(sys.stdin)
reports = [c['body'] for c in d['comments'] if 'truss-audit-state' in c.get('body','')]
if not reports:
    print('no-audit -'); sys.exit()
body = reports[-1]
blocks = re.findall(r'\`\`\`json\s*\n(.*?)\`\`\`', body, re.S)
try:
    data = json.loads(blocks[-1])
    f = data.get('findings', [])
    ch = sum(1 for x in f if x.get('severity') in ('critical','high'))
    print(data.get('verdict','?'), ch)
except Exception:
    print('unparseable', '-')
" 2>/dev/null)"
  printf "%-4s %-18s %-7s %-5s %-11s %s\n" "$pr" "${verdict:-?}" "${ch:--}" "$ci" "$mergeable" "$title"
done
