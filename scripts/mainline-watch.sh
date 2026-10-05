#!/bin/bash
# mainline-watch.sh — keep truss.rewis on origin/main.
# Every few minutes (cron): if origin/main moved AND the shared checkout is
# safe to touch (on main, clean tracked tree, no rebase/merge in flight),
# fast-forward it, reinstall, rebuild, and restart the truss service.
#
# Safety contract with the work sessions (config/agent/work-session.md):
# workers leave this checkout ON main with a clean tree whenever idle, so a
# pull here never yanks live work. If the checkout is dirty or on a branch,
# we skip — a worker is mid-task and the next tick will catch it.
set -u
cd /home/ubuntu/projects/truss || exit 1

git fetch origin -q || exit 0
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0   # current
[ "$(git branch --show-current)" = "main" ] || { echo "$(date -Is) skip: on $(git branch --show-current)"; exit 0; }
git diff --quiet && git diff --cached --quiet || { echo "$(date -Is) skip: dirty tree"; exit 0; }
# untracked work files can block a ff merge that writes the same paths
[ -z "$(git status --porcelain --untracked-files=normal -- . ':!*.log' | head -1)" ] || { echo "$(date -Is) skip: untracked files present"; exit 0; }
[ ! -d .git/rebase-merge ] && [ ! -f .git/MERGE_HEAD ] || { echo "$(date -Is) skip: rebase/merge in flight"; exit 0; }

OLD=$(git rev-parse --short HEAD)
git merge --ff-only origin/main -q || { echo "$(date -Is) skip: main not ff"; exit 0; }
NEW=$(git rev-parse --short HEAD)
echo "$(date -Is) main moved $OLD -> $NEW — rebuilding"

export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"
pnpm install --frozen-lockfile -q && pnpm -r run build > /dev/null || { echo "$(date -Is) BUILD FAILED, not restarting"; exit 1; }
sudo -n systemctl restart truss && echo "$(date -Is) truss.service restarted on $NEW"
