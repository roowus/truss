# Truss UI redesign brief (delta)

> **You are a senior product designer and front-end engineer.** Truss is feature-complete and verified live; the owner finds the current UI *bad*. This is a **redesign of the presentation layer only**. The app, its panels, and its behaviors exist and work. Read the code for everything not stated here. Don't re-spec the product, don't add features.

**Where to get context (read these, don't duplicate them):** `apps/web/src/` (the working implementation), `packages/proto/src/index.ts` (events), `apps/server/src/index.ts` (routes), `docs/ui-handoff.md` (v1 brief with the API tables and the harness behavior matrix), `docs/mockups/` and `docs/ui-design.md` (one previously explored direction; reference material, not gospel).

## What's bad (design against this)

- **No hierarchy.** Everything is 11 to 12px, mostly monospace, one weight, same hairline borders. Headers, content, and metadata read identical.
- **Chrome tax.** Every panel burns a header bar. Sidebar plus desktop strip plus status bar stack three more. Content is starved at 900px, and narrow panes (~250px) are where this app lives.
- **The sidebar is a wall.** Sessions differ by a 12px icon and truncated text.
- **Tab strip.** Compression works (keep it) but titles evaporate fast, and the active state is invisible.
- **Bland empties and errors.** Numbers without judgement: cost and context show data but never say "this is high." Feed cards don't punch, even though the inbox is the morning page. Motion is accidental: a new feed card should *arrive*, a permission card should *demand*.
- A density toggle exists but only nudges row heights.

## Hard constraints (user-mandated, do not regress)

1. **Tabs**: no overflow dropdown, **no horizontal scroll**. Tabs compress to fit like Chrome. The close X appears only while hovering the tab (never pinned, not even on the active tab). Narrow slivers pop the X over the icon (favicon swap) so the rest of the tab stays a safe click target. Middle-click closes. Right-click opens the copy/move menu. Tabs drag between panes and workspaces.
2. **Realtime, always event-driven.** The `/events` socket has a 15s heartbeat, a client watchdog, and resync on reconnect. Never fetch-poll. Two devices stay in sync for free.
3. **Seq dedupe** per session view. Replay never resurrects dead sessions.
4. Dockview and xterm.js carry weight. Replace only after reading the pitfalls in `docs/ui-handoff.md` §7. Theme Dockview through its `--dv-*` variables, not class overrides.
5. Keep a **token layer** (`apps/web/src/index.css`, the `--t-*` set). Rename or rehue freely, but panels reference tokens, not literals. Dark first; a light theme earns points if the tokens hold (the owner's sibling app is light).
6. Respect `prefers-reduced-motion`. Virtualize long lists if you add weight. `?demo` mode must keep rendering everything.
7. Deploy loop: `pnpm -C apps/web build` and restart the server. Verify against the live local server with Playwright (chromium is installed).

## What to add or change (the actual work)

- **A real visual language**: a type scale with at least two levels of hierarchy, a palette with semantic roles (not eight flat accents), a spacing rhythm, and panel chrome that earns its pixels (or none).
- **Sidebar redesign**: sessions scannable at a glance (state, harness, project, activity) without a wall of identical rows.
- **Tab strip polish**: a legible active state, graceful title starvation, sliver tabs that still communicate.
- **Feed as the morning page**: unread and importance should punch. A visual language per card type (decision, report, todo, finished, error). Motion on arrival.
- **Chat and composer**: thinking versus answer truly distinct, permission cards prominent, the dead-session resume affordance clear.
- **Trajectory**: failures, retries, and cost glanceable; dense but readable rows.
- **Empty and error states with a voice and a next action.**
- **Status bar**: ambient connection, cost, and harness state worth the pixels.
- **Motion**: subtle, purposeful, off under reduced-motion.

## Process (hard gates)

1. Read code first (order: `components/Workspace.tsx` → `lib/store.ts` → `index.css` → `panels/*`).
2. **One mockup HTML** of the daily-driver arrangement (chat | trajectory | feed, ~250px panes) before touching the app. Get the language approved.
3. Implement behind the same component props. Panels keep their data wiring.
4. Verify with Playwright at 1500×900 **and** ~700px wide: before/after screenshots per surface. Seed real content first (`POST /api/todos`, a `post_feed` call via `POST /mcp/truss/<sid>`, a pi session with a turn). Empty states are a lie otherwise.
5. Prove: tab physics at 250px panes, two-browser sync, honest resume after a server restart, keyboard-only feed triage.
6. Update `PLAN.md` when shipped. Leave `docs/mockups/` untouched (history).
