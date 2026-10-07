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
1b. **Backfill missing priorities first.** Any open bug/enhancement issue
    with no `priority: *` label gets one from you right now (you are reading
    them anyway): `gh issue edit <n> --add-label "priority: <level>"` with a
    judgment call from the title/body. Intake sessions skip this step often
    enough that the pipeline owns it. Never label `new feature` /
    `area: platform` issues (excluded below; the developer prioritizes those
    when they pull the label).
 2. Drop anything that:
   - is already being worked: a PR body or title references it
     (`gh pr list --repo roowus/truss --state open --json number,title,body`
     and match `#<issue>`), or a branch named for it exists
   - needs planning, not coding: labeled `new feature` or `area: platform` —
     UNLESS it also carries `build-me`, the developer's explicit go signal
     (they label it when they want it built; everything else in those classes
     stays parked). The developer designs those first; `build-me` is how they
     release one to the pipeline at their own pace.
   - is labeled `question`, `duplicate`, `wontfix`, `invalid`
3. Sort what remains: `priority: critical` first, then `high`, then
   `medium`, then `low`; ties broken by oldest first.
4. Take the top candidate. Read it fully
   (`gh issue view <n> --json title,body,labels`). Confirm its suggested
   approach is still plausible against the current repo (a quick look at the
   files it names).
5. Spawn the work session over the dsh-spawn plugin (one call creates a
   sidebar-visible session and starts it on the work prompt):

   ```sh
   curl -sS -X POST http://127.0.0.1:3080/plugins/dsh-spawn/session \
     -H 'content-type: application/json' -d @- <<'JSON'
   {"cwd": "/home/ubuntu/projects/truss-automation",
    "title": "#<n> [working] — <slug>",
    "group": "truss automation",
    "prompt": "You are a work session for the truss repo. The repo is at /home/ubuntu/projects/truss — work there (cd first; your cwd is the automation home, which only anchors your sidebar group). Read /home/ubuntu/projects/truss/config/agent/work-session.md and follow it fully. Your issue is #<n> — start at phase 1."}
   JSON
   ```
   The `cwd` is the automation home on purpose: DSH groups a session under
   the workspace over its cwd, so workers file under "truss automation"
   while doing the actual work in the real repo. The response is
   `{"sessionId": "session-…"}` — that id is the worker.
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
