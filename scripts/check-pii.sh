#!/usr/bin/env bash
# check-pii.sh — block commits that leak real identifying infrastructure.
#
# Why this exists: the test suite uses tailnet hostnames and LAN IPs as
# fixtures. Twice now those fixtures were canned from a REAL `tailscale
# status` rather than invented, which published this box's tailnet id,
# hostnames and IPs to a public repo.
#
# The rule: fixtures must use reserved/example names. Real ones are blocked.
#
# Usage:
#   scripts/check-pii.sh            # scan staged changes (pre-commit)
#   scripts/check-pii.sh --all      # scan every file in the work tree
#   scripts/check-pii.sh --rev A..B # scan a commit range (CI)
#
# Exit 1 with a report if anything real is found.
#
# CI enforces this (the `pii-guard` job, which `verify` depends on), so a
# leak cannot merge. To also catch it locally before it is ever committed:
#
#   ln -sf ../../scripts/check-pii.sh .git/hooks/pre-commit
#
# The repo has no husky/lefthook, so the hook is a per-clone opt-in; CI is
# the path that is always on.
#
# NOTE: this script is the one file allowed to contain the real values — it
# is the detector. It allowlists itself by basename.

set -uo pipefail

# --- What we consider REAL (must never be committed) ------------------------
# Keep this list narrow enough that it never fires on the placeholder
# vocabulary the repo already uses (example.ts.net, devbox.lan, 100.64.0.x).

# The real tailnet suffix. `example.ts.net` / `tail-example.ts.net` are fine.
REAL_TAILNET='tail208cbf\.ts\.net'

# Real tailnet IPs observed on this tailnet (CGNAT 100.64/10).
REAL_IPS='100\.107\.125\.118|100\.78\.180\.43|100\.121\.74\.109|100\.76\.136\.77|100\.101\.193\.72|100\.71\.154\.2|100\.72\.223\.32|100\.80\.142\.92|100\.83\.217\.120'
# Real tailnet IPv6 ULA.
REAL_V6='fd7a:115c:a1e0::d228:b42c'

# Real machine hostnames. These are FULL or distinctive names only — a bare
# `pixel` or `exit-node` would fire on the word "pixel" in CSS comments and on
# the placeholder itself, which is exactly the false-positive trap.
# `rewin` and `exit-rig` are word-anchored so they do not match English prose
# ("rewind", "exit-rigging"): a false positive here blocks every commit, so
# each short name is bounded on both sides by a non-letter.
#
# The scan is CASE-INSENSITIVE (grep -i), because these names are written
# several ways in practice: `Rewiss-MacBook-Pro`, `Rewiss Macbook Pro` and
# `rewissmacbookpro` all appeared, and an earlier case-sensitive list matched
# only the lower-case hyphenated form — which occurred nowhere in the tree.
# The guard was green while the identifiers were present, which is worse than
# no guard. Enumerate the STEM, not each spelling: separators vary, so match
# `rewiss?[^a-z0-9]*macbook`-style shapes and let -i cover the casing.
REAL_HOSTS='rewvis|rewiss|rinuxfedola|pixel-4-xl|(^|[^a-z])exit-rig([^a-z]|$)|lewiss-iphone|lewiss-ipad|lewiss-imac-pro|(^|[^a-z])rewin([^a-z]|$)|macbook-pro-80'
# The real device label, in every spelling seen: `Rewiss Macbook Pro`,
# `Rewiss-MacBook-Pro`, `rewissmacbookpro`. `rewiss?` then any run of
# non-alphanumerics then `macbook` catches all three (and the hyphen-free
# form, where the run is empty). Case-folding is handled by grep -i.
REAL_DEVICE_LABEL='rewiss?[^a-z0-9]*macbook'

# Real personal identifiers: the tailnet login, the macOS/Linux home path.
# NOTE: deliberately NOT `doubletake` — that is a public product of the same
# owner (github.com/roowus/doubletake) and is referenced on purpose.
REAL_PERSONAL='lewishelh|/Users/rewis\b|/home/rewis\b|rewis/projects'

PATTERN="(${REAL_TAILNET}|${REAL_IPS}|${REAL_V6}|${REAL_HOSTS}|${REAL_DEVICE_LABEL}|${REAL_PERSONAL})"

# Files that legitimately document the sanitization rule itself. This is a
# `case` GLOB, not an ERE — `case` matches shell patterns, so `^`, `(`, `|`
# and `$` are literal, and a pattern built in a variable does not gain
# alternation when expanded ($A as one word is a single pattern). The
# patterns are therefore written literally here. (`pii-guard.test.ts` pins
# that this branch is live: the guard's own failure message tells readers to
# use it, and a dead escape hatch is worse than none.)
SELF_BASENAME='check-pii.sh'
is_allowlisted() {
  case "${1:-}" in
    scripts/check-pii.sh|.github/workflows/*.yml|.github/workflows/*.yaml) return 0 ;;
    *) return 1 ;;
  esac
}

mode="${1:-staged}"
# File lists are kept NUL-delimited (-z) and iterated with `read -d ''`.
# Splitting on whitespace would silently skip any path containing a space —
# a complete bypass of the guard for exactly the file someone pasted a real
# hostname into, which is what the regression test pins. The list goes
# through a temp file rather than a pipe so the loop stays in THIS shell
# (a pipeline would run it in a subshell and lose $hits and the exit code).
list=$(mktemp) || exit 2
trap 'rm -f "$list"' EXIT

case "$mode" in
  staged)  git diff --cached --name-only -z --diff-filter=ACMR >"$list" ;;
  # Tracked AND untracked-but-not-ignored: `git ls-files` alone would miss a
  # brand-new fixture file, which is exactly where a pasted real hostname
  # lands. CI checks out a clean tree where everything is tracked, so this
  # only matters for the by-hand local run — but the message below tells the
  # reader this scans "everything currently in the work tree", so it must.
  --all)   { git ls-files -z; git ls-files -z --others --exclude-standard; } >"$list" ;;
  --rev)   git diff --name-only -z "${2:?need a rev range}" >"$list" ;;
  *) echo "check-pii: unknown mode '$mode'" >&2; exit 2 ;;
esac

hits=0
report=""
# fd 3, not stdin: the body runs `git show`/`grep`, and anything that reads
# stdin would otherwise consume the list out from under the loop.
exec 3<"$list"
while IFS= read -r -d '' f <&3; do
  is_allowlisted "$f" && continue
  # Skip the guard itself wherever it lives (it documents the patterns).
  [ "$(basename -- "$f")" = "$SELF_BASENAME" ] && continue
  [ -f "$f" ] || continue

  # Skip binaries outright — grep -I below also guards, but this avoids
  # reading multi-MB blobs (db/wal/png) into memory for no reason.
  case "$f" in
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.pdf|*.db|*.db-wal|*.db-shm|*.woff|*.woff2|*.ttf) continue ;;
  esac

  # -I = treat binary as non-matching (no "null byte" warnings, no false hits).
  # Scan the staged blob for pre-commit, the work-tree file otherwise.
  if [ "$mode" = "staged" ]; then
    matches=$(git show ":$f" 2>/dev/null | grep -niIE "$PATTERN" 2>/dev/null)
  else
    matches=$(grep -niIE "$PATTERN" -- "$f" 2>/dev/null)
  fi

  if [ -n "$matches" ]; then
    hits=$((hits + 1))
    report="${report}
  ${f}
$(printf '%s\n' "$matches" | sed 's/^/      /' | head -6)"
  fi
done

if [ "$hits" -gt 0 ]; then
  cat >&2 <<EOF

  ✗ commit blocked: real infrastructure identifiers found

$report

  This repo is PUBLIC. Real tailnet hostnames, tailnet IPs and personal
  paths must not be committed. Use the placeholder vocabulary instead:

      <real-host>.<real-tailnet>  ->  devbox.example.ts.net
      <real-tailnet-ip>           ->  100.64.0.10
      /Users/<real-user>          ->  /Users/you   (or /home/you)
      alex-macbook-pro            ->  macbook-pro.example.ts.net

  The placeholder vocabulary (example.ts.net, tail-example.ts.net,
  devbox.lan, 100.64.0.x, /Users/you) is deliberately NOT in the pattern
  list — it must always pass. See TRUSS.md "Test fixtures" for the rule.

  If a match is a genuine false positive, add the path to `is_allowlisted`
  in scripts/check-pii.sh — do not weaken the pattern.

  To see everything currently in the work tree:  scripts/check-pii.sh --all

EOF
  exit 1
fi

exit 0
