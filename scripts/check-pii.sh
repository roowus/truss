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

set -uo pipefail

# --- What we consider REAL (must never be committed) ------------------------
# Keep this list narrow enough that it never fires on the placeholder
# vocabulary the repo already uses (example.ts.net, devbox.lan, 100.64.0.x).

# The real tailnet suffix. `example.ts.net` / `tail-example.ts.net` are fine.
REAL_TAILNET='tail208cbf\.ts\.net'

# Real tailnet IPs observed on this tailnet (CGNAT 100.64/10).
REAL_IPS='100\.107\.125\.118|100\.78\.180\.43|100\.121\.74\.109|100\.76\.136\.77|100\.101\.193\.72|100\.71\.154\.2|100\.72\.223\.32|100\.80\.142\.92|100\.83\.217\.120|100\.93\.'
# Newly minted tailnet IPv6 ULA prefix for this tailnet.
REAL_V6='fd7a:115c:a1e0::1'

# Real machine hostnames (short forms, as they appear in fixtures/docs).
# `rewin` is anchored so it does not match e.g. "rewind".
REAL_HOSTS='devbox|alex-macbook-pro|fedora-box|pixel|exit-node|iphone|ipad|imac-pro|(^|[^a-z])rewin([^a-z]|$)|macbook-pro-2'

# Real personal identifiers. NOTE: deliberately NOT `doubletake` — that is a
# public product of the same owner (github.com/roowus/doubletake), referenced
# on purpose. We only block *personal path* leaks here.
REAL_PERSONAL='lewishelh|/Users/alice\b|/home/alice\b|rewis/projects'

PATTERN="(${REAL_TAILNET}|${REAL_IPS}|${REAL_V6}|${REAL_HOSTS}|${REAL_PERSONAL})"

# Files that legitimately document the sanitization rule itself. Matched on
# BASENAME so the guard still works if the script is vendored elsewhere.
ALLOWLIST='^(scripts/check-pii\.sh|\.github/workflows/.*\.ya?ml)$'
SELF_BASENAME='check-pii.sh'

mode="${1:-staged}"
case "$mode" in
  staged)  files=$(git diff --cached --name-only --diff-filter=ACMR) ;;
  --all)   files=$(git ls-files) ;;
  --rev)   files=$(git diff --name-only "${2:?need a rev range}") ;;
  *) echo "check-pii: unknown mode '$mode'" >&2; exit 2 ;;
esac

[ -z "${files:-}" ] && exit 0

hits=0
report=""
for f in $files; do
  case "$f" in
    $ALLOWLIST) continue ;;
  esac
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
    matches=$(git show ":$f" 2>/dev/null | grep -nIE "$PATTERN" 2>/dev/null)
  else
    matches=$(grep -nIE "$PATTERN" -- "$f" 2>/dev/null)
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

      devbox.example.ts.net   ->  devbox.example.ts.net
      100.64.0.1            ->  100.64.0.1
      /Users/alice               ->  /Users/alice   (or /home/you)
      alex-macbook-pro         ->  macbook-pro.example.ts.net

  If a match is a genuine false positive, add the file to ALLOWLIST in
  scripts/check-pii.sh — do not weaken the pattern.

  To see everything currently in the work tree:  scripts/check-pii.sh --all

EOF
  exit 1
fi

exit 0
