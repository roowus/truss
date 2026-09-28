# Truss — Architecture

## Shape

```
apps/web        React 19 + Vite + Tailwind 4 + Dockview + xterm.js
apps/server     Fastify (Node 22) — REST + WS event bus, session store, plugin loader
packages/proto  internal event schema (ACP-aligned + per-LLM-call step events)
packages/adapters  claude-code | hermes | pi | dsh
packages/node-agent  daemon for remote hosts
```

## Data flow

```
harness process ──(adapter: spawn/drive)──▶ normalize ──▶ proto events
                                                          │
                              ┌───────────────────────────┤
                              ▼                           ▼
                        SQLite store                 WS broadcast
                              │                           │
                              └───────────▶ web clients (all devices)
```

- The server spawns harness adapters as child processes, or drives remote harnesses through a node-agent over WebSocket.
- Adapters emit normalized events (`packages/proto`): message chunks, tool-call lifecycle, permission requests, usage, and **per-LLM-call step events** (model, latency, tokens in/out, cost, retries) for the trajectory view.
- Every event is persisted to SQLite (`apps/server/data/truss.db`) and broadcast to all connected clients, so panels survive reload and multiple devices stay in sync.
- Terminal tabs are xterm.js in the web app bound to node-pty sessions on the server.

## Plugin model

Two plugin kinds share one manifest (`plugin.json`):

- **adapter** — adds a harness. Implements `spawn`, `send`, `events`, `interrupt`, and capability flags (permissions? subagents? streaming?).
- **panel** — adds a UI panel. Ships a sandboxed iframe bundle (MCP Apps style) plus declared event subscriptions.

Built-in panels (trajectory, context, subagents, memory, skills, terminal) are plugins compiled into the default install — the core has no special cases.

## Event schema (proto)

ACP-aligned at the boundary, extended internally:

- `session.*` — lifecycle, model, cwd, harness
- `msg.chunk` / `msg.done` — streamed text
- `tool.call` / `tool.update` / `tool.done` — pending → in_progress → completed
- `perm.request` / `perm.resolve` — permission card round-trip
- `llm.call.start` / `llm.call.done` — per-API-call rows (the trajectory view)
- `subagent.spawn` / `subagent.done` — team tree
- `ctx.usage` — context window occupancy by category

## Why ACP at the boundary

Purpose-built for "any editor ↔ any agent": streamed chunks, tool-call lifecycle, `session/request_permission`, elicitation, plan updates, usage/cost. Hermes already ships `hermes-acp`; pi's RPC mode maps 1:1; Claude Code's stream-json translates cleanly. See `docs/adapters.md`.
