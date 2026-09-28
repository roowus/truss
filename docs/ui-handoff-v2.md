# Truss — UI redesign brief (delta)

> **You are a senior product designer + front-end engineer.** Truss is
> feature-complete and verified live; the owner finds the current UI *bad*.
> This is a **redesign of the presentation layer only** — the app, its panels,
> and its behaviors exist and work. Read the code for everything not stated
> here; don't re-spec the product, don't add features.

**Context sources (read, don't duplicate):** `apps/web/src/` (reference impl),
`packages/proto/src/index.ts` (events), `apps/server/src/index.ts` (routes),
`docs/ui-handoff.md` (v1 brief — API tables + harness behavior matrix),
`docs/mockups/` + `docs/ui-design.md` (one previously explored direction;
reference, not gospel).

## What's bad (design against this)

- **No hierarchy** — everything is 11–12px monospace at one volume; headers,
  content, and metadata read identical.
- **Chrome tax** — every panel burns a header bar; sidebar + desktop strip +
  status bar stack three more. Content is starved at 900px, and narrow panes
  (~250px) are where this app *lives*.
- **Sidebar is a wall** — sessions differ by a 12px icon + truncated text.
- **Tab strip** — compression works (keep it) but titles evaporate; active
  state is invisible.
- **Bland empties/errors; numbers without judgement** (cost/context show data,
  never "this is high"); **feed cards don't punch** despite being the morning
  page; **motion is accidental** (a new feed card should *arrive*, a
  permission card should *demand*).
- Density toggle exists but only nudges row heights.

## Hard constraints (user-mandated — do not regress)

1. **Tabs**: no overflow dropdown, **no horizontal scroll** — tabs compress to
   fit like Chrome; the close **X appears only while hovering the tab** (not
   pinned on active); middle-click closes; right-click = copy/move menu; drag
   between panes and workspaces.
2. **Realtime, always event-driven** — `/events` WS (15s heartbeat + watchdog
   + resync-on-reconnect). Never fetch-poll. Two devices stay in sync for free.
3. **Seq dedupe** per session view; replay never resurrects dead sessions.
4. Dockview + xterm.js carry weight — replace only after reading
   `docs/ui-handoff.md` §7 pitfalls; theme Dockview via `--dv-*` vars.
5. Keep a **token layer** (`apps/web/src/index.css` `--t-*` — rename/rehue
   freely, but panels reference tokens, not literals). Dark-first; a light
   theme earns points if tokens hold (the owner's sibling app is light).
6. `prefers-reduced-motion`; virtualize long lists if you add weight;
   `?demo` mode must keep rendering everything.
7. Deploy loop: `pnpm -C apps/web build && sudo systemctl restart truss`;
   verify against the live server (`127.0.0.1:4040` by default) with Playwright (chromium installed).

## What to add/change (the actual work)

- **A real visual language**: type scale with 2+ levels of hierarchy, a
  palette with semantic roles (not 8 flat accents), spacing rhythm, panel
  chrome that earns its pixels (or none).
- **Sidebar redesign**: sessions scannable at a glance (state, harness,
  project, activity) without a wall of identical rows.
- **Tab strip polish**: legible active state, graceful title starvation,
  favicon-mode tabs that still communicate.
- **Feed as the morning page**: unread/importance that punch; type language
  per card (decision/report/todo/finished/error); motion on arrival.
- **Chat + composer**: thinking vs answer truly distinct; permission cards
  prominent; dead-session/resume affordance clear.
- **Trajectory**: glanceable failures/retries/cost, dense but readable rows.
- **Empty/error states with voice and a next action.**
- **Status bar**: ambient connection/cost/harness state worth the pixels.
- Motion system: subtle, purposeful, off under reduced-motion.

## Process (hard gates)

1. Read code first (order: `components/Workspace.tsx` → `lib/store.ts` →
   `index.css` → `panels/*`).
2. **One mockup HTML** of the daily-driver arrangement (chat | trajectory |
   feed, ~250px panes) before touching the app — get the language approved.
3. Implement behind the same component props; panels keep their data wiring.
4. Verify with Playwright at 1500×900 **and** ~700px viewport: screenshots
   before/after per surface; seed real content first (`POST /api/todos`,
   `POST /mcp/truss/<sid>` `post_feed`, a pi session with a turn) — empty
   states are a lie otherwise.
5. Prove: tab physics at 250px pane, two-browser sync, `systemctl restart
   truss` honest-resume, keyboard-only triage of the feed.
6. Update `PLAN.md` when shipped. Leave `docs/mockups/` untouched (history).
