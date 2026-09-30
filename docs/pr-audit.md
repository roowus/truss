# PR audit automations

Two comment-triggered workflows, defined in `.github/workflows/`.

## Setup (once)

1. Add two repository secrets (Settings → Secrets and variables → Actions):
   `ZAI_API_KEY` (primary) and `FIREWORKS_API_KEY` (fallback). The keys live
   only in GitHub secrets; they are never in the repo.
2. Confirm the model IDs and base URLs at the top of each workflow
   (`GLM_MODEL`, `KIMI_MODEL`, `ZAI_BASE_URL`, `FW_BASE_URL`). If the GLM id
   404s, try `glm-4.5-flash`.

## Models and fallback

The primary model is GLM via Z.AI. The fallback is Kimi via Fireworks, and it
kicks in two ways:

1. Any agent step that fails on GLM (for example the key is out of credits)
   retries the same round once on Kimi.
2. In the loop, if a round's critical/high findings are identical to the
   previous round's (no progress — the same issues are not getting solved),
   the fix stage switches to Kimi for that round.

The loop's 3-round cap is the hard "3 tries" bound: anything still churning
after that is posted for a human.

## `~run-audit`

Comment `~run-audit` on any PR. The `pr-audit` workflow audits the diff for
bugs, security issues, and compliance with `TRUSS.md`, then posts a report as
a PR comment. Every report ends with three standing verdicts
(Proportionality, Test Coverage, Business-Logic Risk) and a machine-readable
JSON block that the loop below consumes.

## `~audit-loop`

Comment `~audit-loop` on a PR. The `pr-audit-loop` workflow runs up to three
rounds of: audit the head, validate each critical/important finding
adversarially (valid, not worth it, refuted, out of scope), fix the valid
ones with tests per `TRUSS.md`, push one commit per round, and re-audit. It
stops when a round finds nothing major, and always posts a summary. Merging
stays a human decision; `ci` runs on each pushed head as usual.

## Guardrails

- Only comments by the repo owner trigger either workflow.
- Both workflows share one concurrency group per PR (`truss-audit-<number>`),
  so an audit and a loop never run on the same PR at once. A second trigger
  queues instead of interrupting.
- The loop only runs on same-repo PRs, because the fix stage installs
  dependencies and runs the PR's own code.
- Agents treat all PR content (code, title, body, linked issues) as untrusted
  data. The fix agent commits but never pushes; a workflow-owned step pushes,
  pinned to the PR branch. Agents never edit `.github/workflows/**`.
