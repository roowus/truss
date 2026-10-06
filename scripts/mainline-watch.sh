#!/bin/bash
# mainline-watch.sh — keep truss.rewis on origin/main.
#
# Production runs from a DEDICATED checkout (/home/ubuntu/projects/truss-prod)
# that no worker, developer, or cron ever edits — deploys are unconditional
# force-syncs there, never blocked by dev activity in the shared checkout.
# (The pre-prod-checkout guards lived here; they died with the coupling.)
#
# Every tick: ask the RUNNING service what commit it serves (/health carries
# it since #137); if it's behind origin/main, sync, build, restart, verify.
set -u
PROD=/home/ubuntu/projects/truss-prod
cd "$PROD" || exit 1

git fetch origin -q || exit 0
LIVE=$(curl -fsS -m 3 http://127.0.0.1:4040/health 2>/dev/null | sed -n 's/.*"commit":"\([0-9a-f]\{7,40\}\)".*/\1/p')
[ "$LIVE" = "$(git rev-parse origin/main)" ] && exit 0   # actually current

OLD=$(git rev-parse --short HEAD)
# dedicated checkout: never edited by anyone but us, so reset is the truth
git reset --hard origin/main -q || { echo "$(date -Is) reset failed"; exit 1; }
NEW=$(git rev-parse --short HEAD)
NEWFULL=$(git rev-parse HEAD)
echo "$(date -Is) main moved $OLD -> $NEW (live was ${LIVE:-pre-sha}) — rebuilding"

export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"
pnpm install --frozen-lockfile -q && pnpm -r run build > /dev/null || { echo "$(date -Is) BUILD FAILED, not restarting"; exit 1; }
sudo -n systemctl restart truss || { echo "$(date -Is) restart command failed on $NEW"; exit 1; }

# Verify the restart actually took (issue #135): a stale process squatting
# :4040 makes the fresh service crash-loop on EADDRINUSE while the squatter
# keeps serving — `systemctl restart` still exits 0 and nothing changed.
# Ask /health which commit is answering and refuse to claim success on a
# mismatch.
verified=""
for _ in $(seq 1 15); do
  body=$(curl -fsS -m 3 http://127.0.0.1:4040/health 2>/dev/null) || { sleep 2; continue; }
  live=$(printf '%s' "$body" | sed -n 's/.*"commit":"\([0-9a-f]\{7,40\}\)".*/\1/p')
  if [ -z "$live" ]; then
    echo "$(date -Is) STALE: /health answers but carries no commit — an old build still owns :4040 (squatter?)"
    break
  fi
  if [ "$live" = "$NEWFULL" ]; then verified=1; break; fi
  echo "$(date -Is) STALE: /health serves $live, expected $NEWFULL — squatter still owns :4040?"
  break
done
if [ -z "$verified" ]; then
  echo "$(date -Is) RESTART DID NOT TAKE on $NEW — recent service log:"
  { journalctl -u truss -n 30 --no-pager 2>/dev/null || sudo -n journalctl -u truss -n 30 --no-pager 2>/dev/null; } | grep -iE "EADDRINUSE|error" || true
  exit 1
fi
echo "$(date -Is) truss.service restarted on $NEW (verified via /health)"
