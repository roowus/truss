#!/bin/bash
# Drives the stacked PR audit-merge chain (roowus/truss PRs 43-78).
# Every 5 min via cron. Rules:
#  - at most 5 audit loops in flight (the user's cap)
#  - merge a PR when: its base is main (predecessors merged) AND the loop's
#    latest report converged (no critical/high remaining) AND CI on the head
#    is green
#  - trigger ~audit-loop on the head PR(s) until 5 are in flight
#  - approve parked (action_required) CI runs on PR branches
set -uo pipefail
# RETIRED 2026-10-02: the ~audit-loop workflow this drove is deleted; the
# label + work-session pipeline (docs/pr-audit.md) replaced it. Early-exit
# so the still-armed DSH cron "PR audit-merge driver (truss)"
# (schedule-512141a8-e127-4e1b-a694-7bfeb40c9c9c) becomes a no-op — delete
# that cron in the DSH Tasks panel to stop the 5-minute deliveries.
echo "$(date -Is) pr-audit-driver is retired; delete the DSH cron 'PR audit-merge driver (truss)'" >> /var/tmp/pr-audit-driver.log
exit 0
cd /home/ubuntu/projects/truss
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
LOG=/var/tmp/pr-audit-driver.log
echo "=== $(date -u +%H:%M:%S) ===" >> $LOG

OPEN=$(gh pr list -R roowus/truss --limit 50 --json number,headRefName,baseRefName --jq 'sort_by(.number) | .[] | "\(.number) \(.headRefName) \(.baseRefName)"' 2>/dev/null)
[ -z "$OPEN" ] && exit 0

# approve parked CI on PR branches
gh run list -R roowus/truss --limit 20 --json databaseId,status,workflowName --jq '.[] | select(.status == "action_required" or .status == "waiting") | .databaseId' 2>/dev/null | while read -r rid; do
  [ -n "$rid" ] && gh api -X POST "repos/roowus/truss/actions/runs/$rid/approve" >> $LOG 2>&1
done

# count in-flight loops
INFLIGHT=$(gh run list -R roowus/truss --limit 30 --json status,workflowName --jq '[.[] | select(.workflowName == "pr-audit-loop" and .status != "completed")] | length' 2>/dev/null || echo 5)

# only the lowest-numbered open PR is the merge/trigger candidate (the chain
# head) — every PR's base is main after retargeting, so base can't order us;
# the number can. Branches are cumulative, so merging out of order would land
# unaudited work.
HEAD_PR=$(echo "$OPEN" | head -1 | cut -d' ' -f1)

while read -r pr branch base; do
  [ -z "$pr" ] && continue
  [ "$pr" != "$HEAD_PR" ] && continue
  KEYS_DEAD=/var/tmp/pr-audit-keys-dead

  TITLE_PREFIX=$(gh pr view "$pr" -R roowus/truss --json title --jq .title 2>/dev/null | python3 -c "import sys; print(sys.stdin.read()[:30])")
  # gh has no --arg; inline the prefix. HAS_LOOP = any loop run ever for this PR.
  HAS_LOOP=$(gh run list -R roowus/truss --limit 40 --json displayTitle,workflowName --jq "[.[] | select(.workflowName == \"pr-audit-loop\" and (.displayTitle | startswith(\"${TITLE_PREFIX}\")))] | length" 2>/dev/null || echo 0)
  # never trigger while THIS PR has a loop running (queued duplicates just waste cycles)
  ACTIVE_LOOP=$(gh run list -R roowus/truss --limit 40 --json displayTitle,workflowName,status --jq "[.[] | select(.workflowName == \"pr-audit-loop\" and .status != \"completed\" and (.displayTitle | startswith(\"${TITLE_PREFIX}\")))] | length" 2>/dev/null || echo 0)

  # a PR with a loop in flight is off-limits entirely: no merge while auditing
  if [ "$ACTIVE_LOOP" != "0" ]; then
    continue
  fi

  # loop state for this PR: latest loop report comment
  SUMMARY=$(gh pr view "$pr" -R roowus/truss --json comments --jq '[.comments[] | select(.body | test("Audit round|Fix round|Audit-fix|loop summary|verdict"))] | last | .body' 2>/dev/null)

  if [ "$HAS_LOOP" = "0" ]; then
    if [ -f "$KEYS_DEAD" ]; then
      continue  # model keys are down — don't trigger doomed audits
    fi
    if [ "$INFLIGHT" -lt 5 ]; then
      gh pr comment "$pr" -R roowus/truss --body "~audit-loop" >> $LOG 2>&1
      echo "triggered loop on PR $pr" >> $LOG
      INFLIGHT=$((INFLIGHT + 1))
    fi
    continue
  fi

  # settled loop without a clean verdict → retrigger it, at most once per head
  HEADSHA_NOW=$(gh pr view "$pr" -R roowus/truss --json headRefOid --jq .headRefOid 2>/dev/null)
  STATE=/var/tmp/pr-audit-driver.state
  LAST_SHA=$(grep "^$pr " $STATE 2>/dev/null | cut -d' ' -f2)
  if [ "$ACTIVE_LOOP" = "0" ] && [ "$HAS_LOOP" != "0" ] && [ ! -f "$KEYS_DEAD" ] && [ -n "$HEADSHA_NOW" ] && [ "$LAST_SHA" != "$HEADSHA_NOW" ]; then
    echo "$pr $HEADSHA_NOW" >> $STATE
    gh pr comment "$pr" -R roowus/truss --body "~audit-loop" >> $LOG 2>&1
    echo "retriggered stalled loop on PR $pr (head $HEADSHA_NOW)" >> $LOG
    continue
  fi

  # converged? the summary shows approve/converged with zero critical+high remaining
  if echo "$SUMMARY" | grep -qE '"verdict": "approve"|signal: `converged`|no critical/high'; then
    if echo "$SUMMARY" | grep -qE '"severity": "critical"|"severity": "high"'; then
      echo "PR $pr: critical/high findings remain — not merging" >> $LOG
      continue
    fi
    HEADSHA=$(gh pr view "$pr" -R roowus/truss --json headRefOid --jq .headRefOid 2>/dev/null)
    CI=$(gh run list -R roowus/truss --branch "$branch" --workflow ci.yml --limit 5 --json headSha,conclusion,status --jq "[.[] | select(.headSha == \"$HEADSHA\" and .status == \"completed\")] | .[0].conclusion // \"none\"" 2>/dev/null)
    if [ "$CI" = "SUCCESS" ] || [ "$CI" = "success" ]; then
      if gh pr merge "$pr" -R roowus/truss --merge >> $LOG 2>&1; then
        echo "MERGED PR $pr" >> $LOG
        # preview lifecycle: merged -> tilt down + worktree gone + route gone
        sudo /usr/local/sbin/truss-pr-route down "$pr" >> $LOG 2>&1
        systemctl stop "truss-pr@$pr" >> $LOG 2>&1
        /home/ubuntu/projects/truss/pr-preview/clean-bucket.sh "$pr" >> $LOG 2>&1  # dormant w/o creds
      fi
    else
      echo "PR $pr converged but CI=$CI — waiting" >> $LOG
    fi
  fi
done <<< "$OPEN"

# preview lifecycle: PRs with in-flight audit loops get a live preview at
# https://pr-<N>.truss.rewis (tilt + per-PR caddy route); merged ones go down
gh run list -R roowus/truss --limit 30 --json status,workflowName,displayTitle --jq '.[] | select(.workflowName == "pr-audit-loop" and .status != "completed") | .displayTitle' 2>/dev/null | while read -r title; do
  prnum=$(echo "$OPEN" | grep -F "$(echo "$title" | head -c 25)" | head -1 | cut -d' ' -f1)
  [ -z "$prnum" ] && continue
  systemctl is-active --quiet "truss-pr@$prnum" && continue
  sudo /usr/local/sbin/truss-pr-route up "$prnum" >> $LOG 2>&1
  systemctl start "truss-pr@$prnum" >> $LOG 2>&1 && echo "preview up: pr-$prnum.truss.rewis" >> $LOG
  /home/ubuntu/projects/truss/pr-preview/pack.sh "$prnum" >> $LOG 2>&1 &  # dormant w/o creds
done
exit 0
