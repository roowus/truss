# Truss — UI handoff

> **To whoever builds the UI:** the backend is done, verified, and stable. This document splits deliberately into two parts:
>
> - **The contract (non-negotiable)** — the API, the event model, and the functional behaviors the product needs. These exist and are tested; build against them as-is.
> - **The canvas (yours)** — layout, visual language, interaction patterns, typography, color. You have full creative freedom. Nothing about the current UI's look is sacred — it was a functional first pass, and the owner has explicitly released you from it.
>
> A previous design iteration lives in `docs/mockups/` (v1–v11) with a token/pattern summary in `docs/ui-design.md` — keep them as *reference material* (one direction that was explored), not as a spec.

---

## 1. What Truss is

A **universal "head" for AI agentic-loop harnesses** — Truss is not a harness, it hosts them. One user, self-hosted, reachable from any of their devices. The product thesis: every agentic harness (today: pi, Claude Code, DeepSeek Harness, Hermes; tomorrow: anything speaking ACP or stream-json) deserves one great interface, and the interface should treat harnesses like plugins.

The interesting UI problem: the user runs *several harnesses at once* and watches them work — streaming text, tool calls firing, subagents fanning out, permissions needing answers, tokens burning. Truss is closer to an observability console crossed with a chat client than to either alone. The signature idea from the original brief: a **trajectory view** — "the Chrome network tab for LLM calls."

## 2. Live deployment & dev loop

- Prod example: a reverse proxy (Caddy/nginx) → systemd service → Fastify `127.0.0.1:4040`, which serves the built web app (`apps/web/dist`) + REST + both WS channels. Deploy: `pnpm -C apps/web build && <restart the service>`.
- Dev: `pnpm dev` → Vite `:4041` proxying `/api`, `/events`, `/api/terminal/*` to Fastify `:4040` (tsx watch). Stop the systemd service first, or set `TRUSS_PORT`.
- The frontend stack today is React 19 + Vite + Tailwind 4 + Dockview + xterm.js. **Dockview and xterm.js carry real weight** (window management, terminal emulation); you may replace anything else, and you may replace those too if you have something better — but read §6 first.

## 3. THE CONTRACT — API surface (non-negotiable)

Same-origin REST; in dev these proxy through Vite.

| Route | Shape | Notes |
|---|---|---|
| `GET /health` | `{ok, service, time}` | |
| `GET /api/harnesses` | `{harnesses: [{id, capabilities}], models: [{harness, provider, model, label}]}` | `capabilities = {permissions, subagents, streaming, queueWhileRunning}`. Harness ids: `pi`, `dsh`, `claude-code`, `hermes`, and remote `<adapter>@<host>` ids when node-agents are connected (`GET /api/agents` → `{agents:[{hostId, hostname, adapters}]}`). |
| `GET /api/sessions` | `{sessions: [SessionMeta]}` | `SessionMeta = {id, harness, title, cwd, model?, project?, state, created_at, updated_at, live}`; `state ∈ spawning \| idle \| running \| error \| closed`; newest activity first. |
| `POST /api/sessions` | `{harness, cwd, model?, provider?, title?, project?}` → `{session}` | Spawns the harness process. |
| `GET /api/sessions/:id` | `{session}` | |
| `GET /api/sessions/:id/events` | `{events: [{seq, ev}]}` | Full replay for hydration — see the seq rule in §5. |
| `POST /api/sessions/:id/prompt` | `{text}` → `{ok}` | Prompting a `closed`/`error` session with a stored harness ref **resumes the harness transparently** (pi `--session`, claude `--resume`, dsh/hermes `session/resume`). 409 if unresumable. |
| `POST /api/sessions/:id/interrupt` | → `{ok}` | Abort the running turn. |
| `POST /api/sessions/:id/permission` | `{requestId, choice}` → `{ok}` | Answers a permission card; `choice` must be one of the `perm.request.options`. |
| `DELETE /api/sessions/:id` | `?hard=1` deletes history too | Soft close disposes the process; hard deletes the row + events. |
| `GET /api/terminals` · `POST /api/terminals {cwd?, title?}` · `DELETE /api/terminals/:id` | | Free shells on the server host. |
| `GET /api/skills?cwd=` | `{skills: [{name, description, source, scope}]}` | Agent-Skills-spec dirs visible to that cwd. |
| `GET /api/layout` · `PUT /api/layout {layout: string}` | | Opaque serialized layout blob, stored server-side (currently Dockview's `toJSON`; if you switch layout engines, keep the same two endpoints with your format). |

### WebSocket channels

- **`/events`** — the global event bus; every frame is `{"seq": <int>, "ev": <ProtoEvent>}` covering all sessions.
- **`/api/terminal/:id/ws`** — terminal I/O. Server→client: `{type:"hello", title, alive}`, `{type:"out", data}` (on attach, one `out` frame replays up to 128KB of scrollback before live data), `{type:"exit", code}`. Client→server: `{type:"in", data}`, `{type:"resize", cols, rows}`.

## 4. THE CONTRACT — events (`packages/proto`)

All events carry `sessionId`. Everything the UI renders derives from these:

| Event | Fields | Semantics |
|---|---|---|
| `session.created` | `harness, title, cwd, model?, project?, at` | |
| `session.state` | `state, detail?` | Drives "is this chat alive / busy / dead" everywhere. |
| `msg.start` | `messageId, role (user\|assistant\|system), at` | Open a message. |
| `msg.chunk` | `messageId, text, channel?` | Append text. `channel:"thinking"` = model reasoning — keep it visually distinct from the answer (this is a user-facing contract, not decoration). |
| `msg.done` | `messageId, stopReason?` | Settle. `stopReason` starting `error:` = failure. |
| `tool.call` | `toolCallId, name, args, callId?` | A tool started. `callId` links it to a trajectory row (`llm.call.start`). |
| `tool.update` | `toolCallId, output?` | Partial output while running. |
| `tool.done` | `toolCallId, ok, durationMs?, output?` | Settled. |
| `perm.request` | `requestId, tool, reason, options[]` | **A permission card that blocks the turn** until the user answers. This is the bidirectional core of the product — it must be prominent, never a footnote. |
| `perm.resolve` | `requestId, choice` | Answered (drop the card). |
| `llm.call.start` | `callId, model, at` | A trajectory row opens. |
| `llm.call.done` | `callId, status, latencyMs, tokensIn?, tokensOut?, costUsd?, retryOf?` | Row closes. `retryOf` links a retry to the failed call. **dsh/hermes report no per-call tokens** — show absence honestly (`—`), not `0`. |
| `subagent.spawn` | `agentId, label, parentAgentId?` | Team tree node (claude-code emits these for its Task/Agent tool). |
| `subagent.done` | `agentId, ok` | |
| `ctx.usage` | `used, total, by?` | Context-window occupancy. `by` (per-category) is reserved for harnesses that report it — none do yet; don't invent it. |

## 5. THE CONTRACT — state model (non-negotiable mechanics)

However you structure client state, these rules are load-bearing:

1. **Seq dedupe.** Every frame has `seq` (SQLite rowid, monotonic per row). Per session track `lastSeq` and drop anything `<=` it. Hydration (`GET .../events`) and the live bus overlap constantly — without this every message renders twice.
2. **Replay never resurrects.** History contains old `session.state: idle` events. The REST session row is authoritative for current state; a `closed` session stays closed until a prompt resumes it.
3. **Auto-title refresh.** The server renames "new session" from the first prompt — refetch the session list on user `msg.done`.
4. **Id uniqueness across resume.** Adapters restart processes on resume; message/call ids carry per-spawn prefixes server-side. If you mint ids client-side, include spawn/session context — never a bare counter.
5. **Terminal lifecycle.** Closing a terminal's UI must `DELETE /api/terminals/:id` or the pty leaks server-side. Attach replays scrollback before live data.

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

`capabilities.queueWhileRunning` from `/api/harnesses` tells you which composers may accept input during a run — disable/hold with explanation for the others.

## 6. THE CANVAS — your creative freedom

Everything visual and spatial is yours. To scope "bare essential functionality," the product must let the user:

- **Browse and manage sessions** across harnesses (list, state, open, close, delete, group by project — the `project` field exists for this).
- **Create sessions**: harness picker, model picker (from `/api/harnesses` `models`), working directory, optional project.
- **Chat**: stream answers live, distinguish thinking from output, see tool calls with status/duration/output, answer permission cards inline, interrupt a run, know when a session is dead and what happens if you prompt it (resurrection).
- **Trajectory**: see every LLM call with when/hownlong/what-model/tokens/cost, expand into the tools that ran inside it, spot retries/failures at a glance.
- **Terminals**: real shells in the UI (xterm-grade), free shells and "a shell in this session's cwd" (agent-shell).
- **Panels**: context usage, subagent tree, skills — as first-class openable surfaces.
- **Workspace**: multiple simultaneous views (chat next to trajectory next to terminal is the daily-driver arrangement), rearranged by the user, **persisting across reloads** via `/api/layout`.
- **Multi-device**: two browsers stay in sync through the event bus for free — don't break that (i.e., stay event-driven, don't fetch-poll).
- **Status**: connection state, running agents, context, cost — ambient, glanceable.

The reference implementation (`apps/web/src/` today) is a *working* answer to all of the above with intentionally plain presentation — mine it for wiring (dockBus bridge, store shape, api client) and replace the rest freely. `docs/mockups/variant-11-nocturne-abyss.html` shows one dark, dense, Dracula-flavored direction that was previously explored; it is explicitly **not** a requirement.

## 7. Technical pitfalls (physics, not taste)

These are integration-level traps I already hit — they apply under any design:

1. **Dockview theming** (if you keep it): theme through its `--dv-*` CSS variables; class-selector overrides lose specificity wars.
2. **Dockview mount race**: never `addPanel` synchronously inside `onReady` — defer a frame or you get `Invalid grid element`.
3. **xterm**: `fit()` throws on a zero-size host — guard dimensions, refit on `ResizeObserver`, and push `resize` frames to the server after every fit.
4. **JSONL framing** (adapters/parsers): split on LF only; U+2028/U+2029 are legal inside JSON strings (Node `readline` gets this wrong).
5. **Fonts/GPU**: terminals and chat timelines are hot paths — keep them out of layout-thrash loops and respect `prefers-reduced-motion`.
6. **Service restarts drop WS**: reconnect with backoff; on reconnect, rehydrate active sessions (events may have been missed).
7. **Harness boot latency**: the first `dsh` session takes 5–10s (its plugin stack boots). Show spawning honestly.

## 8. Acceptance (functional — verify with Playwright, don't claim without proof)

1. Create one session per harness; each answers a chat.
2. Mid-run: streaming is visibly live, thinking distinct from output, tool rows show lifecycle, interrupt works.
3. A risky tool call on claude/dsh/hermes raises a permission card; "allow" executes it (prove with a file on disk).
4. Trajectory accumulates rows with latency; expansion shows the turn's tools; dsh rows show `—` for tokens, pi shows real numbers.
5. Terminal: type → output; resize → reflow; reload → scrollback repaints.
6. `systemctl restart truss` mid-session → UI shows sessions honestly dead → prompting one resumes it and it **remembers context** (codeword test).
7. Rearrange the workspace → reload → identical.
8. Two browser windows stay in sync.
9. Layout/API errors surface as readable UI, never silent voids.
