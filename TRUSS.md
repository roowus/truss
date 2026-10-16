# Truss practices

House rules for anyone (human or agent) working in this repo.

## Coding

- pnpm, never npm.
- Typecheck before claiming done: `pnpm -r run lint`.
- Build must stay green: `pnpm -r run build`.
- Every feature, fix, and behavior change ships with tests in the same
  commit. No exceptions for "small" changes; small bugs are still bugs.
  `pnpm test` must pass before pushing.
- Tests live in `apps/server/test/` (node:test + tsx, temp TRUSS_DATA_DIR via
  `freshServer`) and `apps/web/test/` (pure helpers + store reducers). Follow
  the existing files' pattern.
- Regressions get a regression test first, then the fix.
- Plain human language in docs and comments. No em dashes in user-facing
  copy, no AI jargon.

## Test fixtures

This repo is PUBLIC, so fixtures must use **reserved names only** — never
real infrastructure from the machine you are working on. A fixture canned
from a live `tailscale status` publishes this box's tailnet id, hostnames
and IP map to everyone who clones, permanently.

Use the placeholder vocabulary:

| Instead of | Use |
| --- | --- |
| the real tailnet suffix | `example.ts.net`, `tail-example.ts.net` |
| a real tailnet hostname | `devbox.example.ts.net`, `node2.example.ts.net` |
| a real tailnet IP | `100.64.0.x` (reserved CGNAT) |
| a real LAN name | `devbox.lan` |
| a real home path | `/Users/you`, `/home/you` |
| a real device label | `Devbox Laptop`, `Phone A` |

`scripts/check-pii.sh` enforces this: it scans staged changes
(pre-commit), the work tree (`--all`), and a commit range (`--rev A..B`,
used by CI's `pii-guard` job). Its pattern list holds only the **real**
values, so the placeholder vocabulary above always passes. If it fires on
a genuine false positive, allowlist that file — do not weaken the pattern.

The guard scans comments too, so **describe a real identifier's shape, do
not quote it** — a comment that spells one out is itself the disclosure,
and the guard will (correctly) block the commit. That is also why its own
tests assemble their literals from fragments: an allowlisted test file
would be a blind spot exactly where someone is most likely to paste a
real value.

## Branches

- New work branches off `origin/main` after a fetch, never off another PR
  branch. No cumulative/stacked branches: every PR's diff vs main must be
  exactly its own work, so PRs can be audited and merged in any order.
- If main has moved since the branch was cut, rebase onto `origin/main`
  before opening or updating the PR.

## Commits

- Commit author and committer are always the repo owner
  (`roowus <roowus@users.noreply.github.com>`), including automation-made
  commits — bots act on the owner's behalf and do not get credit lines.
- No AI-attribution trailers or banners in commit messages: no
  `Co-Authored-By:` lines, no "Generated with …" footers, no tool names.
- PR titles follow conventional-commit style, ≤70 chars; the body opens with
  1-3 plain sentences (what was broken, what the PR does) before any lists.

## Posting

- File todos for anything the user must verify by hand; label them `verify`.
- Post one report per research task. No chatter.
