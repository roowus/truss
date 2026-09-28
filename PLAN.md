# Truss plan

## What this is

A plugin-based, universal **frontend ("head") for AI agentic-loop harnesses**, not a harness itself. Truss hosts harnesses (Claude Code, DeepSeek Harness, pi, Hermes to start), lets the user run each chat on a chosen harness, and renders all of them in one consistent UI.

Core UI: sidebar (project-grouped sessions, harnesses, panels) plus a **dockable/tileable workspace**. Tabs hold chats, terminals, or any panel; windows split horizontally and vertically (up to quarters); every window has its own tab bar.

Native (pre-installed plugin) panels: context tracker, subagent/team visualization, task list, built-in terminal, **trajectory** (Chrome network tab for LLM calls), skills, memory.

## Locked decisions

- **Form factor**: web app (local server + browser, reachable from all devices on your private network). Optional Tauri/Electron shell later.
- **Adapter model**: headless/structured per harness; no PTY scraping in v1.
- **Protocol**: ACP (Agent Client Protocol) at the harness boundary; internal event bus with per-LLM-call step events for trajectory; MCP Apps model for third-party plugin panels (sandboxed iframes).
- **Persistence**: backend owns a SQLite store (sessions, transcripts, trajectory events, layout state). Mirrors harness data.
- **Plugins, two levels**: harness adapters + UI panels, same manifest API.
- **Interactivity**: bidirectional. User prompts AND agent-to-user permission/question cards.
- **Remote-capable**: harnesses run behind a node-agent daemon (local = same box; remote = another host over your private network). Coded for from day 1.
- **UI reference**: `docs/mockups/variant-11-nocturne-abyss.html`. See `docs/ui-design.md`.

## Milestones

| M | Goal | Status |
|---|---|---|
| M0 | Scaffold: repo, monorepo, server health, Dockview shell rendering the v11 look, CI | ✅ |
| M1 | First harness end-to-end: **pi** adapter (RPC mode): chat, stream, persist, trajectory rows | ✅ |
| M2 | Terminals: xterm.js + node-pty tabs | ✅ |
| M3 | **Hermes** adapter (hermes-acp over stdio) + permission cards | ✅ |
| M4 | **Claude Code** adapter (stream-json + MCP permission host over HTTP) | ✅ |
| M5 | Native panels: trajectory detail, context tracker, subagents, memory | ✅ (memory stays stub, no harness memory API yet) |
| M6 | **DSH** adapter: local ACP (the Truss host can BE the dsh host, no bridge needed) | ✅ |
| M7 | Node-agent ✅ · Tauri shell (scaffolded, build on Mac, `apps/desktop`) ✅ · mobile-responsive pass (UI-owned, open) | ✅ except mobile |
| M8 | dsh-lab parity: Files/Git/Tasks panels, Skills switches (enable/disable/create/trash), Cost daily windows + heat grid, Context stat tiles + cache-hit (pi/claude); tabs: no dropdown/no scroll, Chrome-style compress-to-fit + in-tab X on hover | ✅ (cron scheduling deferred) |
| M9 | realtime sync: 15s WS heartbeat + client zombie watchdog (45s) + wake-resync on visibilitychange, `session.deleted` broadcast, fixed dead reconnect-resync (`onConn` never matched "closed", always "connecting") | ✅ |
| M10 | Todos + Feed + Practices: agent-filed user todos (priority/deadline/labels/subtasks/meta, 4 views), unified actionable inbox (perms/work-done/task-runs/errors/context/reports), per-session MCP identity + todo ownership with approval cards, share-to-agent (chat + agent-visible), TRUSS.md practices (global → project → folder chain) via MCP instructions + pi first-prompt | ✅ |
| M11 | Remote hosts for real: registered host registry (online/offline, last seen), per-host agent tokens (hashed, shown once, rotate/revoke), add-host wizard (tailscale detect + guidance, direct-IP/NetBird/ZeroTier/WireGuard path, plaintext warning), bundled agent installer (`GET /agent/install.sh`, esbuild ESM at boot, systemd --user unit), agent hosts all four adapters + derives TRUSS_MCP_BASE from the dial-out URL, tailscale serve toggle in Settings | ✅ |
| M12 | Monitor tab: zero-dep /proc+/sys vitals collector shared by server and node-agent, metrics_req/metrics tunnel frames, `/api/metrics` with rolling history rings, Monitor panel (device chips, gauges, sparklines, per-core, PSI, disks, net rates, top processes) | ✅ |
| M13 | Test suite + CI: node:test coverage for store/sessions/practices/todos/feed/hosts/net/metrics/pi-adapter (fake-pi RPC E2E)/tasks/skills/files/git + web format/reducers, GitHub workflow (lint, build, test). Fix: resume persisted provider (silent 400 on resumed pi chats), provider errors surface in chat via message_end stopReason, agent install systemd unit .mjs | ✅ |

### M1 notes (landed)

- pi adapter drives `pi --mode rpc` (LF-framed JSONL); maps `turn_*` → `llm.call.*` trajectory rows with usage, `tool_execution_*` → `tool.*` scaffold rows, `auto_retry_*` → linked retry rows, `agent_settled` → idle.
- Events are SQLite-persisted and broadcast as `{seq, ev}` frames; clients dedupe replay vs live by rowid.
- Server restart closes all sessions (pi processes die with it); closed sessions stay listed and their transcripts replay read-only from the event log.
- The full v11 shell runs on Dockview: per-window tab bars, 1px splitters, chat + trajectory + terminal stub, sidebar groups, composer dock, status bar.
- Dev host note: pi's model catalog can ride a local key-proxy (`~/.pi/agent/models.json`); a 9router instance works too.

## Docs

- [docs/architecture.md](./docs/architecture.md): system layout, event flow, packages
- [docs/adapters.md](./docs/adapters.md): per-harness integration contract
- [docs/ui-design.md](./docs/ui-design.md): design tokens + UI patterns (the v11 contract)
