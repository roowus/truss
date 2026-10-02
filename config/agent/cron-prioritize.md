# Cron: pick the next issue to work

Runs on a schedule. Your whole job is to decide whether to start work on an
issue right now, and if so, which one. Cheap and deterministic: no wandering.

## Steps

0. **Orphaned PRs first.** Read
   `~/.local/state/truss-audit-spool/ORPHANS.txt` (the audit watcher
   maintains it): PRs labeled `audit` with no `agent-session:` marker have
   an armed audit loop but nobody fixing. If any are listed, hand the
   oldest one to a work session (config/agent/work-session.md — the
   adoption path covers existing PRs) before picking a new issue below.
1. List candidates:
   `gh issue list --repo roowus/truss --state open --json number,title,labels,createdAt`
2. Drop anything that:
   - is already being worked: a PR body or title references it
     (`gh pr list --repo roowus/truss --state open --json number,title,body`
     and match `#<issue>`), or a branch named for it exists
   - needs planning, not coding: labeled `new feature` or `area: platform`
     without a concrete suggested approach in the body (read the body if in
     doubt — those are the ones a human designs first)
   - is labeled `question`, `duplicate`, `wontfix`, `invalid`
3. Sort what remains: `priority: high` first, then `medium`, then `low`;
   ties broken by oldest first.
4. Take the top candidate. Read it fully
   (`gh issue view <n> --json title,body,labels`). Confirm its suggested
   approach is still plausible against the current repo (a quick look at the
   files it names).
5. Spawn the work session over the dsh-spawn plugin (one call creates a
   sidebar-visible session and starts it on the work prompt):

   ```sh
   curl -sS -X POST http://127.0.0.1:3080/plugins/dsh-spawn/session \
     -H 'content-type: application/json' -d @- <<'JSON'
   {"cwd": "/home/ubuntu/projects/truss",
    "title": "work: #<n> — <slug>",
    "prompt": "You are a work session for the truss repo. Read /home/ubuntu/projects/truss/config/agent/work-session.md and follow it fully. Your issue is #<n> — start at phase 1."}
   JSON
   ```
   The response is `{"sessionId": "session-…"}` — that id is the worker.
   Update the project board item to in-progress:
   `gh project item-edit ...` (see docs/pr-audit.md for the PAT setup).
6. Record the mapping so the developer can watch the worker: append
   `{"issue": <n>, "session": "<the spawned session's id>", "since": "<iso>",
   "state": "working"}` to `~/.local/state/truss-sessions.json` (a JSON
   array; create if missing). The work session keeps its own entry current
   (config/agent/work-session.md phase 1 step 0).
7. Post one line to the feed: which issue started, why it won, and the
   session id that owns it.

If nothing qualifies, do nothing and end the turn. A quiet pass is a
success, not a failure.

Never start more than one issue per tick. Never start one whose work session
is already alive.
