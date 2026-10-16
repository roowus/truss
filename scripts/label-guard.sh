#!/bin/bash
# label-guard.sh — enforce the two label families on open issues.
# Every open bug/feature/enhancement issue must carry a `priority:*` and a
# `complexity:*` label (the intake agent assigns both; this is the backstop).
# Missing complexity gets the conservative default `medium` (an unlabeled issue
# must never be silently treated as trivial); missing priority gets `medium`.
# Every fill is logged loudly — auto-defaults are a safety net, not a policy.
set -u
REPO=roowus/truss
[ -n "${GH_TOKEN:-}" ] || GH_TOKEN=$(grep "^GH_PROJECT_PAT" /opt/dsh/.env | cut -d= -f2)
export GH_TOKEN

filled=0
while IFS=$'\t' read -r num title labels; do
  [ -n "$num" ] || continue
  # tracking/verify/question issues are not pipeline work
  case "$labels" in
    *question*|*duplicate*|*wontfix*|*invalid*|*tracking*) continue ;;
  esac
  miss=""
  case "$labels" in *priority:*) ;; *) miss="$miss priority" ;; esac
  case "$labels" in *complexity:*) ;; *) miss="$miss complexity" ;; esac
  [ -z "$miss" ] && continue
  for m in $miss; do
    if [ "$m" = priority ]; then
      gh issue edit "$num" -R "$REPO" --add-label "priority: medium" >/dev/null 2>&1 && \
        echo "$(date -Is) issue #$num: AUTO-DEFAULT priority: medium (was missing) — $title"
    else
      gh issue edit "$num" -R "$REPO" --add-label "complexity: medium" >/dev/null 2>&1 && \
        echo "$(date -Is) issue #$num: AUTO-DEFAULT complexity: medium (was missing) — $title"
    fi
    filled=$((filled+1))
  done
done < <(gh issue list -R "$REPO" --state open --limit 100 --json number,title,labels \
  --jq '.[] | "\(.number)\t\(.title)\t\([.labels[].name] | join(","))"')

[ "$filled" -gt 0 ] && echo "$(date -Is) label-guard filled $filled label(s) — review them; auto-defaults hide intake misses"
exit 0
