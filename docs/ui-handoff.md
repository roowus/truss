# Truss UI handoff

> **To whoever builds the UI:** the backend is done, verified, and stable. This document splits in two on purpose:
>
> - **The contract (non-negotiable)**: the API, the event model, and the functional behaviors the product needs. These exist and are tested. Build against them as-is.
> - **The canvas (yours)**: layout, visual language, interaction patterns, typography, color. You have full creative freedom. Nothing about the current UI's look is sacred. It was a functional first pass, and the owner has explicitly released you from it.
>
> A previous design iteration lives in `docs/mockups/` (v1 to v11) with a token and pattern summary in `docs/ui-design.md`. Treat those as reference material (one direction that was explored), not as a spec.
>
> **Newer note:** `docs/ui-handoff-v2.md` is the current brief. This file stays for its API tables and the harness behavior matrix.

---

## 1. What Truss is

A universal head for AI agent harnesses. Truss is not a harness, it hosts them. One user, self-hosted, reachable from any of their devices. The product thesis: every agentic harness (today: pi, Claude Code, DeepSeek Harness, Hermes; tomorrow: anything speaking ACP or stream-json) deserves one great interface, and the interface should treat harnesses like plugins.

The interesting UI problem: the user runs *several harnesses at once* and watches them work. Streaming text, tool calls firing, subagents fanning out, permissions needing answers, tokens burning. Truss is closer to an observability console crossed with a chat client than to either alone. The signature idea from the original brief: a trajectory view, "the Chrome network tab for LLM calls."

## 2. Live deployment and dev loop

- A typical prod setup: a reverse proxy (Caddy or nginx) in front of a systemd service running the Fastify server on `127.0.0.1:4040`, which serves the built web app (`apps/web/dist`) plus REST and both WS channels. Deploy: `pnpm -C apps/web build` and restart the service.
- Dev: `pnpm dev` runs Vite on `:4041` proxying `/api`, `/events`, `/api/terminal/*` to Fastify on `:4040` (tsx watch). Stop the systemd service first, or set `TRUSS_PORT`.
- The frontend stack today is React 19 + Vite + Tailwind 4 + Dockview + xterm.js. **Dockview and xterm.js carry real weight** (window management, terminal emulation). You may replace anything else, and you may replace those too if you have something better, but read §6 first.

## 3. THE CONTRACT: API surface (non-negotiable)

Same-origin REST. In dev these proxy through Vite.

| Route | Shape | Notes |
|---|---|---|
| `GET /health` | `{ok, service, time}` | |
| `GET /api/harnesses` | `{harnesses: [{id, capabilities}], models: [{harness, provider, model, label}]}` | `capabilities = {permissions, subagents, streaming, queueWhileRunning}`. Harness ids: `pi`, `dsh`, `claude-code`, `hermes`, and remote `<adapter>@<host>` ids when node agents are connected (`GET /api/agents` → `{agents:[{hostId, hostname, adapters}]}`). `?probe=1` one-shot-probes lazy adapters (hermes/dsh) whose catalog is empty — the New Session dialog passes it on open; a filled catalog arrives as a `models.updated` broadcast, so refetch on that event. Plain fetches never spawn harness processes. |
| `GET /api/sessions` | `{sessions: [SessionMeta]}` | `SessionMeta = {id, harness, title, cwd, model?, project?, state, created_at, updated_at, live}`; `state ∈ spawning \| idle \| running \| error \| closed`; newest activity first. |
| `POST /api/sessions` | `{harness, cwd, model?, provider?, title?, project?}` → `{session}` | Spawns the harness process. |
| `GET /api/sessions/:id` | `{session}` | |
| `GET /api/sessions/:id/events` | `{events: [{seq, ev}]}` | Full replay for hydration. See the seq rule in §5. |
| `POST /api/sessions/:id/prompt` | `{text}` → `{ok}` | Prompting a `closed`/`error` session with a stored harness ref **resumes the harness transparently** (pi `--session`, claude `--resume`, dsh/hermes `session/resume`). 409 if unresumable. |
| `POST /api/sessions/:id/interrupt` | → `{ok}` | Abort the running turn. |
| `POST /api/sessions/:id/permission` | `{requestId, choice}` → `{ok}` | Answers a permission card; `choice` must be one of the `perm.request.options`. |
| `DELETE /api/sessions/:id` | `?hard=1` deletes history too | Soft close disposes the process; hard deletes the row + events. |
| `GET /api/terminals` · `POST /api/terminals {cwd?, title?}` · `DELETE /api/terminals/:id` | | Free shells on the server host. |
| `GET /api/skills?cwd=` | `{skills: [{name, description, source, scope, disabled?}]}` | Agent-Skills-spec dirs visible to that cwd. Toggle/create/delete via `POST /api/skills/toggle|create|delete`. |
| `GET /api/layout` · `PUT /api/layout {layout: string}` | | Opaque serialized layout blob, stored server-side (currently Dockview's `toJSON`; if you switch layout engines, keep the same two endpoints with your format). |

Newer routes worth knowing: `GET /api/costs` + `GET /api/costs/daily` (cost ledger), `GET/PUT /api/file` + `GET /api/files` (workspace browser), `GET /api/git/*` (status/branches/graph/diff) + `POST /api/git/switch`, `GET/POST/PATCH/DELETE /api/tasks(+/:id/run)` (task board), `GET/POST/PATCH /api/todos` + `POST /api/todos/:id/access` (user todos), `GET /api/feed` + `POST /api/feed/:id/state|share` (inbox), `GET/PUT /api/practices` + `GET /api/practices/compose` (TRUSS.md), and `POST /mcp/truss[/:sessionId]` (the management MCP; the session URL identifies the caller).

### WebSocket channels

- **`/events`**: the global event bus. Every frame is `{"seq": <int>, "ev": <ProtoEvent>}` covering all sessions. The server also sends an app-level `{type:"ping"}` every 15s; browsers can't see protocol pings, so liveness rides the JSON channel. Clients run a watchdog and resync on reconnect.
- **`/api/terminal/:id/ws`**: terminal I/O. Server→client: `{type:"hello", title, alive}`, `{type:"out", data}` (on attach, one `out` frame replays up to 128KB of scrollback before live data), `{type:"exit", code}`. Client→server: `{type:"in", data}`, `{type:"resize", cols, rows}`.

## 4. THE CONTRACT: events (`packages/proto`)

All events carry `sessionId`. Everything the UI renders derives from these:

| Event | Fields | Semantics |
|---|---|---|
| `session.created` | `harness, title, cwd, model?, project?, at` | |
| `session.state` | `state, detail?` | Drives "is this chat alive / busy / dead" everywhere. |
| `session.updated` | `title?, project?, archived?` | Metadata patch (rename, regroup, archive). |
| `session.deleted` | | Hard delete; drop the row. Broadcast only. |
| `msg.start` | `messageId, role (user\|assistant\|system), at` | Open a message. |
| `msg.chunk` | `messageId, text, channel?` | Append text. `channel:"thinking"` = model reasoning. Keep it visually distinct from the answer (this is a user-facing contract, not decoration). |
| `msg.done` | `messageId, stopReason?` | Settle. `stopReason` starting `error:` = failure. |
| `tool.call` | `toolCallId, name, args, callId?` | A tool started. `callId` links it to a trajectory row (`llm.call.start`). |
| `tool.update` | `toolCallId, output?` | Partial output while running. |
| `tool.done` | `toolCallId, ok, durationMs?, output?` | Settled. |
| `perm.request` | `requestId, tool, reason, options[]` | **A permission card that blocks the turn** until the user answers. This is the bidirectional core of the product. It must be prominent, never a footnote. |
| `perm.resolve` | `requestId, choice` | Answered (drop the card). |
| `llm.call.start` | `callId, model, at` | A trajectory row opens. |
| `llm.call.done` | `callId, status, latencyMs, tokensIn?, tokensOut?, costUsd?, cacheRead?, cacheWrite?, retryOf?` | Row closes. `retryOf` links a retry to the failed call. **dsh/hermes report no per-call tokens**; show absence honestly (`—`), not `0`. Cache fields only exist when the harness reports them (pi and claude-code do). |
| `subagent.spawn` | `agentId, label, parentAgentId?` | Team tree node (claude-code emits these for its Task/Agent tool). |
| `subagent.done` | `agentId, ok` | |
| `ctx.usage` | `used, total, by?` | Context-window occupancy. `by` (per-category) is reserved for harnesses that report it; none do yet, so don't invent it. |
| `todo.upsert` | `todo` | Todo store patch. Broadcast only; hydrate with `GET /api/todos`. |
| `feed.upsert` | `item` | Feed store patch. Broadcast only; hydrate with `GET /api/feed`. |
| `models.updated` | `harness` | A lazy adapter's model catalog filled in (first-boot probe). Broadcast only (`sessionId` is ""); refetch `GET /api/harnesses`. |

## 5. THE CONTRACT: state model (non-negotiable mechanics)

However you structure client state, these rules are load-bearing:

1. **Seq dedupe.** Every frame has `seq` (SQLite rowid, monotonic). Per session track `lastSeq` and drop anything `<=` it. Hydration (`GET .../events`) and the live bus overlap constantly; without this every message renders twice.
2. **Replay never resurrects.** History contains old `session.state: idle` events. The REST session row is authoritative for current state; a `closed` session stays closed until a prompt resumes it.
3. **Auto-title refresh.** The server renames "new session" from the first prompt. Refetch the session list on user `msg.done`.
4. **Id uniqueness across resume.** Adapters restart processes on resume; message and call ids carry per-spawn prefixes server-side. If you mint ids client-side, include spawn/session context. Never a bare counter.
5. **Terminal lifecycle.** Closing a terminal's UI must `DELETE /api/terminals/:id` or the pty leaks server-side. Attach replays scrollback before live data.
6. **Reconnect resync.** When the bus drops and comes back, refetch the lists (sessions, terminals, agents, todos, feed) and rehydrate open views. Events may have been missed.

### Harness behavior differences (drive the interaction design)

| | pi | dsh | claude-code | hermes |
|---|---|---|---|---|
| accepts input mid-run | **yes** (queues) | no | no | no |
| streaming granularity | token deltas | committed chunks | committed blocks | small chunks |
| thinking stream | yes | yes | yes | yes |
| permission cards | — | ✓ | ✓ | ✓ |
| subagent events | — | — | ✓ (Task/Agent tool) | — |
| per-call tokens | ✓ | — (turn-level) | turn-level | turn-level |
| ctx usage | ✓ | ✓ | — | ✓ |

`capabilities.queueWhileRunning` from `/api/harnesses` tells you which composers may accept input during a run. Disable or hold with an explanation for the others.

## 6. THE CANVAS: your creative freedom

Everything visual and spatial is yours. To scope "bare essential functionality," the product must let the user:

- Browse and manage sessions across harnesses (list, state, open, close, delete, group by project; the `project` field exists for this).
- Create sessions: harness picker, model picker (from `/api/harnesses` `models`), working directory, optional project.
- Chat: stream answers live, distinguish thinking from output, see tool calls with status/duration/output, answer permission cards inline, interrupt a run, know when a session is dead and what happens if you prompt it (resurrection).
- Trajectory: see every LLM call with when/how-long/what-model/tokens/cost, expand into the tools that ran inside it, spot retries and failures at a glance.
- Terminals: real shells in the UI (xterm grade), free shells and "a shell in this session's cwd" (agent shell).
- Panels: context usage, subagent tree, skills, files, git, tasks, todos, feed, cost, credentials, router, hosts. All first-class openable surfaces.
- Workspace: multiple simultaneous views (chat next to trajectory next to terminal is the daily-driver arrangement), rearranged by the user, **persisting across reloads** via `/api/layout`.
- Multi-device: two browsers stay in sync through the event bus for free. Don't break that (stay event-driven, don't fetch-poll).
- Status: connection state, running agents, context, cost. Ambient, glanceable.

The reference implementation (`apps/web/src/` today) is a *working* answer to all of the above with intentionally plain presentation. Mine it for wiring (the dockBus bridge, store shape, api client) and replace the rest freely. `docs/mockups/variant-11-nocturne-abyss.html` shows one dark, dense, Dracula-flavored direction that was previously explored; it is explicitly **not** a requirement.

## 7. Technical pitfalls (physics, not taste)

These are integration-level traps I already hit. They apply under any design:

1. **Dockview theming** (if you keep it): theme through its `--dv-*` CSS variables; class-selector overrides lose specificity wars.
2. **Dockview mount race**: never `addPanel` synchronously inside `onReady`; defer a frame or you get `Invalid grid element`.
3. **xterm**: `fit()` throws on a zero-size host. Guard dimensions, refit on `ResizeObserver`, and push `resize` frames to the server after every fit.
4. **JSONL framing** (adapters/parsers): split on LF only; U+2028/U+2029 are legal inside JSON strings (Node `readline` gets this wrong).
5. **Fonts/GPU**: terminals and chat timelines are hot paths. Keep them out of layout-thrash loops and respect `prefers-reduced-motion`.
6. **Service restarts drop WS**: reconnect with backoff; on reconnect, rehydrate active sessions (events may have been missed).
7. **Harness boot latency**: the first `dsh` session takes 5 to 10s (its plugin stack boots). Show spawning honestly.

## 8. Acceptance (functional; verify with Playwright, don't claim without proof)

1. Create one session per harness; each answers a chat.
2. Mid-run: streaming is visibly live, thinking distinct from output, tool rows show lifecycle, interrupt works.
3. A risky tool call on claude/dsh/hermes raises a permission card; "allow" executes it (prove with a file on disk).
4. Trajectory accumulates rows with latency; expansion shows the turn's tools; dsh rows show `—` for tokens, pi shows real numbers.
5. Terminal: type → output; resize → reflow; reload → scrollback repaints.
6. Restart the service mid-session → UI shows sessions honestly dead → prompting one resumes it and it **remembers context** (codeword test).
7. Rearrange the workspace → reload → identical.
8. Two browser windows stay in sync.
9. Layout/API errors surface as readable UI, never silent voids.
