# Truss — UI rebuild handoff

> **To the model rebuilding the UI:** the backend is done, verified, and stable. This document is everything you need: what the product is, the design contract, the exact API/event surface, what exists today, the behaviors the new UI must have, and the bugs I already hit so you don't rediscover them. Read `docs/ui-design.md` and `docs/mockups/variant-11-nocturne-abyss.html` first — they are the visual source of truth — then this file for the data side.

---

## 1. What Truss is

A **plugin-based, universal "head" for AI agentic-loop harnesses** — Truss is NOT a harness. It hosts them. The user runs pi, Claude Code, DeepSeek Harness, and Hermes side by side, one chat per harness, in one consistent interface. Single-user, self-hosted, tailnet-reachable. (Minecraft-with-mods philosophy: everything is a plugin; the two plugin levels are *harness adapters* and *UI panels*.)

Core UX promise: **dockable workspace** — sidebar + windows with per-window tab bars; tabs hold chats, terminals, or panels; windows split to quarters; the layout persists across reloads (already implemented — see §7).

The signature surface is the **trajectory panel**: a Chrome-network-tab-for-LLM-calls. Every LLM turn is a row with a latency bar; rows expand into the tools that ran in that turn, token counts, cost, retry lineage.

## 2. Live deployment

- Prod: `https://truss.rewis` (Caddy → `truss.service` → Fastify `127.0.0.1:4040`, serves `apps/web/dist` + API + WS).
- Dev: `pnpm dev` (Fastify `:4040` tsx-watch + Vite `:4041` proxying `/api`, `/events`, `/api/terminal`). Stop the systemd service first or set `TRUSS_PORT`.
- The whole thing is event-sourced: **every UI state derives from one event log** (SQLite `events` table) + live WS frames. If you keep that model, the UI rewrite is mostly mechanical.

## 3. The API surface (REST)

Base URL: same origin (Vite proxies in dev).

| Route | Shape | Notes |
|---|---|---|
| `GET /health` | `{ok, service, time}` | liveness |
| `GET /api/harnesses` | `{harnesses: [{id, capabilities}], models: [{harness, provider, model, label}]}` | `capabilities`: `permissions`, `subagents`, `streaming`, `queueWhileRunning`. Harness ids: `pi`, `dsh`, `claude-code`, `hermes`, plus remote `pi@<host>` / `claude-code@<host>` when node-agents are connected (`GET /api/agents`). |
| `GET /api/sessions` | `{sessions: [SessionMeta]}` | `SessionMeta`: `id, harness, title, cwd, model?, project?, state, created_at, updated_at, live`. `state ∈ spawning \| idle \| running \| error \| closed`. Ordered by `updated_at` desc. |
| `POST /api/sessions` | body `{harness, cwd, model?, provider?, title?, project?}` → `{session}` | Spawns the harness. First `dsh` session boots the shared ACP process (~5–10s). |
| `GET /api/sessions/:id` | `{session}` | |
| `GET /api/sessions/:id/events` | `{events: [{seq, ev}]}` | **Full event replay** for hydration. `seq` = SQLite rowid, monotonic — dedupe key against live frames. |
| `POST /api/sessions/:id/prompt` | `{text}` → `{ok}` | Prompting a `closed`/`error` session with a harness ref **resumes it transparently** (pi `--session`, claude `--resume`, dsh/hermes `session/resume`). 409 if truly dead. |
| `POST /api/sessions/:id/interrupt` | → `{ok}` | Aborts the running turn. |
| `POST /api/sessions/:id/permission` | `{requestId, choice}` → `{ok}` | Answers a permission card (`choice` = one of `perm.request.options`). |
| `DELETE /api/sessions/:id` | `?hard=1` to also delete history | Soft close disposes the harness process; hard deletes row + events. |
| `GET /api/terminals` · `POST /api/terminals` `{cwd?, title?}` · `DELETE /api/terminals/:id` | | Free shells. Terminals die with the server (no persistence). |
| `GET /api/skills?cwd=` | `{skills: [{name, description, source, scope}]}` | Agent-Skills-spec dirs (pi global + project). |
| `GET /api/layout` · `PUT /api/layout` `{layout: string}` | | Dockview serialized JSON blob. |

### WebSocket channels

- **`/events`** — the global event bus. Every frame: `{"seq": <rowid>, "ev": <ProtoEvent>}`. All sessions' events flow here.
- **`/api/terminal/:id/ws`** — terminal I/O. Server→client: `{type:"hello", title, alive}`, `{type:"out", data}`, `{type:"exit", code}`. Client→server: `{type:"in", data}`, `{type:"resize", cols, rows}`. On attach the server replays a 128KB scrollback ring buffer as one `out` frame — paint it before live data.

## 4. The event schema (`packages/proto`)

Every event has `sessionId`. The wire types:

| Event | Fields | Semantics |
|---|---|---|
| `session.created` | `harness, title, cwd, model?, project?, at` | |
| `session.state` | `state, detail?` | Drives sidebar "live" dots, composer enablement, status bar. |
| `msg.start` | `messageId, role (user/assistant/system), at` | Open a bubble. |
| `msg.chunk` | `messageId, text, channel?` | Append text. `channel: "thinking"` = model reasoning → render as the dimmed italic scaffold, NOT body text. |
| `msg.done` | `messageId, stopReason?` | Close the bubble. `stopReason` starting `error:` = render as error. |
| `tool.call` | `toolCallId, name, args, callId?` | Open a scaffold row. `callId` links it to a trajectory row. |
| `tool.update` | `toolCallId, output?` | Partial output while running. |
| `tool.done` | `toolCallId, ok, durationMs?, output?` | Settle the row. |
| `perm.request` | `requestId, tool, reason, options[]` | **Permission card** — block the turn until the user answers. |
| `perm.resolve` | `requestId, choice` | Card answered (remove it). |
| `llm.call.start` | `callId, model, at` | Open a trajectory row. |
| `llm.call.done` | `callId, status, latencyMs, tokensIn?, tokensOut?, costUsd?, retryOf?` | Close it. `retryOf` links a retry to the failed call (orange). **Note:** dsh/hermes report no per-call tokens (ACP gives per-turn usage only) — render `—` when absent, not `0`. |
| `subagent.spawn` | `agentId, label, parentAgentId?` | Team tree node. |
| `subagent.done` | `agentId, ok` | |
| `ctx.usage` | `used, total, by?` | Context occupancy. `by` (per-category) only exists when a harness reports it — none do yet; render the honest fallback. |

### Harness behavioral differences (they matter for UX)

| | pi | dsh | claude-code | hermes |
|---|---|---|---|---|
| wire | `--mode rpc` JSONL | ACP stdio (shared proc) | stream-json stdio | ACP stdio (`hermes-acp`) |
| queue while running | **yes** (follow-up) | no | no | no |
| streaming | token deltas | committed chunks | committed blocks | small chunks |
| thinking channel | yes | yes (thought chunks) | yes (thinking blocks) | yes |
| per-call tokens | yes | no (turn-level) | turn-level | turn-level |
| context usage | yes (per turn) | yes (usage_update) | — | yes |
| permissions | — | cards | cards (MCP host) | cards |
| subagents | — | — | Task/Agent tool → tree | — |
| resume | `--session` | `session/resume` | `--resume` | `session/resume` |

Composer behavior: while a session is `running`, pi can accept a follow-up (queue it); the others must show the composer as waiting (their `capabilities.queueWhileRunning` says which).

## 5. Current UI inventory (what you're replacing)

Everything works but is utilitarian — the user's verdict is "buggy, redo from the ground up." Keep the data wiring, replace the presentation:

- `App.tsx` — Dockview shell, layout persistence, panel registry, new-session modal (harness/model/cwd/project), sidebar splitter drag.
- `components/Sidebar.tsx` — project groups (Chrome-style collapse, color chips), harness logo chips with hover tooltips, panels list, context-gauge footer.
- `components/ChatPanel.tsx` — messages (user bubbles / assistant with who-label / thinking rows / tool scaffold rows with expandable mono output / run-state), permission cards, timeline rail (tick per user turn), composer dock (status stack when tools run, input well, context chips: harness · model · cwd · shell · ctx).
- `components/TrajectoryPanel.tsx` — time-axis ruler (marks per call, cyan "now" line), rows with latency bars, expandable detail (tools + tokens + cost + retry link), aggregate footer.
- `components/TerminalPanel.tsx` — xterm.js + FitAddon over the terminal WS.
- `components/ContextPanel.tsx` — big gauge + input-tokens-per-call bars.
- `components/SubagentsPanel.tsx` — tree from subagent events (real data exists for claude-code).
- `components/SkillsPanel.tsx` — skill rows with scope chips.
- `components/StatusBar.tsx` — agents count, ctx, cost, ws state, clock.
- `store.ts` — the event-sourced client store (see §6). `api.ts` — REST client. `icons.tsx` — SVG sprite + harness logos. `theme.css` — v11 tokens.
- `dockBus.ts` — bridge so dockview panels (which get params-only props) can ask the App to open tabs.

## 6. State management (the part to keep)

One store, three sources merged:

1. `GET /api/sessions` — the session list (authoritative current state).
2. `GET /api/sessions/:id/events` — hydration replay for a session when it's opened (once).
3. `/events` WS — live frames forever after.

**The dedupe rule that matters:** every frame carries `seq` (SQLite rowid). Per session keep `lastSeq`; drop frames with `seq <= lastSeq`. Hydration and live overlap constantly (an event can arrive on WS while you're fetching history) — without this every message doubles.

Derived per-session state: `entries` (chat timeline: messages + tool rows in arrival order), `calls` (trajectory rows), `ctx` (latest usage), `agents` (subagent tree), `perms` (open permission cards).

Auto-title: the server renames "new session" from the first prompt; refetch the session list on user `msg.done`.

## 7. Layout persistence contract

`dockviewApi.toJSON()` → debounce 800ms → `PUT /api/layout`. On boot: `GET /api/layout` → `fromJSON` **before** adding any default panel; only build the default workspace (trajectory right, terminal below it, latest session's chat left) when no layout exists. Restored chat panels carry `params.sessionId` — reopening a chat tab for a `closed` session shows its replayed transcript with a disabled composer; prompting it resumes the harness (server handles it).

## 8. Known pitfalls (I hit every one of these)

1. **Dockview theming**: theme via the `--dv-*` CSS variables (`--dv-activegroup-visiblepanel-tab-background-color` etc.), NOT class selectors — specificity fights lose otherwise. The v11 "active tab lifted to pane color" needs `--dv-activegroup-visiblepanel-tab-background-color: var(--bg-focus)` + inactive to `--bg-pane` + strip to `#0e0f15`.
2. **Dockview mount race**: don't `addPanel` synchronously inside `onReady` — defer with `requestAnimationFrame` or you get `Invalid grid element` (parentless DOM during portal attach).
3. **xterm fit()**: throws on a zero-size host. Guard `clientWidth/Height < 20` and refit on `ResizeObserver`. Also send `{type:"resize"}` after every fit.
4. **Message/call id uniqueness across resume**: harness processes restart on resume; adapter-side counters reset. Ids already carry a per-spawn prefix server-side — if you regenerate ids client-side, include spawn/session context, never a bare counter.
5. **Closed-session replay**: history contains `session.state: idle` events — never let replay resurrect a closed session. The REST row is authoritative; closed is terminal (prompting is the only way back, via resume).
6. **JSONL framing** (if you ever touch adapters): split on LF only; Node `readline` also splits U+2028/U+2029 which are legal inside JSON strings.
7. **Terminal lifecycle**: closing a terminal tab must `DELETE /api/terminals/:id` or the pty leaks (there's a `onDidRemovePanel` hook for this in App.tsx).
8. **Fonts**: Inter (+ Inter Tight for the wordmark) for UI, JetBrains Mono ONLY for terminal/code. Data flavor via Inter OpenType `tnum`/`zero`/`cv11` — never a second family for numbers.
9. **`prefers-reduced-motion`**: blanket-disable animations (the CSS has the media query — keep it).
10. **No `·` separators, no glow** — the user vetoed both explicitly. Hover = soft `--hover` bubble only.

## 9. What the new UI must demonstrate (acceptance)

Verify each with Playwright screenshots — don't claim without proof:

1. Create a session per harness from the new-session flow; all four answer a chat.
2. Mid-stream: text grows token-by-token (pi) / chunk-by-chunk (ACP); thinking renders dimmed; tool rows tick and settle with ✓ + duration.
3. A risky claude/dsh tool call produces a permission card; answering "allow" runs the tool (visible in the row + a file on disk).
4. Trajectory: rows accumulate with latency bars; expanding a row shows its tools + tokens; retries render orange when they happen.
5. Terminal: type a command, see output, resize the window (fit follows), reload the page and the scrollback repaints.
6. `systemctl restart truss` mid-session: sessions go closed; the UI shows it honestly; prompting the closed session resumes the harness and it REMEMBERS context (the adapters do — test with a codeword).
7. Layout: rearrange windows, reload, identical arrangement.
8. Two browser windows (two "devices") stay in sync through the event bus.

## 10. Design contract

`docs/ui-design.md` = tokens + locked patterns (Dracula-at-Night palette, per-window tab bars, 1px overlay splitters, composer dock, scaffold 67% dimming, hover bubbles, project groups, harness logo chips, unfocused-pane recession, no-green rule). `docs/mockups/variant-11-nocturne-abyss.html` = the reference implementation to match. The user iterated 11 variants to lock this — treat it as law, not suggestion. Changes to *locked* elements need explicit user sign-off; everything else (craft, motion, micro-detail) is yours to elevate.
