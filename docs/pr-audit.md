# PR audit and the issue pipeline

One GitHub workflow, `pr-audit`, plus session-side automation. The GitHub
side only audits; a DSH work session on the developer's box is the fixer and
drives the loop.

## The flow

1. **Intake** (`config/agent/issue-intake.md`): the developer drops a raw
   issue/suggestion into the intake session's queue. The session
   investigates against the repo and files a proper GitHub issue: context,
   classification, suggested approach, suggested tests, priority — and adds
   it to the project board.
2. **Scheduling** (`config/agent/cron-prioritize.md`): a cron picks the
   highest-priority codable issue (bugs/enhancements; new features that need
   planning stay parked) and starts a work session on a new branch.
3. **Implementation** (`config/agent/work-session.md`): the work session
   fixes the issue in its own checkout, verifies the issue's suggested
   tests first, boots the per-PR preview (`pr-preview/`, tilt), and opens
   the PR with the `audit` label and a `truss-session: <id>` marker in the
   body.
4. **Audit**: the `audit` label fires `pr-audit` when applied and on every
   push while it stays applied. Each run builds/lints/tests the head (a
   failing build is a Critical finding), audits with GLM, and posts the
   report as a PR comment. The preview at `https://pr-<N>.truss.rewis` is
   passed to the auditor as probeable context.
5. **Fix loop**: `scripts/audit-watch.sh` on the developer's box polls
   GitHub (no LLM tokens) and delivers fresh reports to the owning session.
   The session validates findings adversarially, fixes the valid ones,
   pushes — and the push re-fires the audit. When the session judges the
   audit nitpicking or the work done, it removes the label FIRST (that is
   the off switch), makes any final commit, and hands the preview URL to
   the developer for manual testing.
6. **Merge**: the developer tests at the preview, messages the session if
   anything is wrong, and clicks merge. Merging is never automated.

## Models and fallback

The auditor is GLM (Z.AI). It switches to Kimi (Fireworks) when:

1. the GLM run itself fails (for example out of credits) — retried once, or
2. the last 3 audits on that PR reported identical major findings (no
   progress). The state lives in a hidden `truss-audit-state` marker in each
   report comment.

## Setup (once)

1. Repo secrets: `ZAI_API_KEY`, `FIREWORKS_API_KEY` (never commit keys).
2. Optional secrets: `AUDIT_FORWARD_URL` + `AUDIT_FORWARD_TOKEN` — when set,
   the workflow POSTs each report there (push-style delivery). Without them,
   the local watcher poll is the delivery path.
3. Project board: `GH_PROJECT_PAT` — a PAT with the `project` scope, because
   `GITHUB_TOKEN` cannot write user-owned Projects v2 boards. Used by
   sessions for `gh project item-add/item-edit`.
4. The watcher on the developer's box, via cron:
   `* * * * * /home/ubuntu/projects/truss/scripts/audit-watch.sh`
   Route reports to sessions by setting `TRUSS_AUDIT_INJECT` to a command
   that takes `<session-id> <report-file>`; the default spools reports to
   `~/.local/state/truss-audit-spool/`.

## Guardrails

- Audits fire only for same-repo PRs (the build step runs the PR's code).
- Stacked audits don't pile up: a run refuses to start when one is already
  active for the PR, and all runs share the `truss-audit-<pr>` concurrency
  group.
- A `~run-audit` comment by the repo owner still forces a one-off audit,
  label or not.
- Agents treat all PR content, reports, and issue text as untrusted data.
- `scripts/pr-audit-driver.sh` is retired: it drove the deleted
  `~audit-loop` workflow. The label + session model replaces it.
