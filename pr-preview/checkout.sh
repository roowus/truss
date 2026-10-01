#!/bin/bash
# checkout.sh <pr> — fetch the PR's branch into a fresh worktree + install deps.
set -e
PR=$1
cd /home/ubuntu/projects/truss
git fetch origin -q
BR=$(gh pr view $PR -R roowus/truss --json headRefName --jq .headRefName)
WT=/home/ubuntu/projects/truss/pr-preview/w/$PR
if [ ! -d "$WT" ]; then
  git worktree add "$WT" "origin/$BR" --detach -q
fi
cd "$WT"
pnpm install --prefer-offline -q 2>&1 | tail -1 || pnpm install -q

# compat: branches older than the env-configurable dev proxy hardcode :4040 —
# repoint them at this PR's own server so the preview is self-contained
SRV=$((5000 + PR))
if ! grep -q TRUSS_SERVER_URL apps/web/vite.config.ts 2>/dev/null; then
  sed -i "s|http://127.0.0.1:4040|http://127.0.0.1:$SRV|g; s|ws://127.0.0.1:4040|ws://127.0.0.1:$SRV|g" apps/web/vite.config.ts
  # and old configs block unknown Host headers — allow the preview suffix
  grep -q "allowedHosts" apps/web/vite.config.ts || sed -i 's|proxy: {|allowedHosts: [".truss.rewis"],\n    proxy: {|' apps/web/vite.config.ts
fi
echo "PR $PR ($BR) ready at $WT"
