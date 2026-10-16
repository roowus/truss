# Truss architecture

## Shape

```
apps/web        React 19 + Vite + Tailwind 4 + Dockview + xterm.js
apps/server     Fastify (Node 22): REST + WS event bus, session store, plugin loader
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

- The server spawns harness adapters as child processes, or drives remote harnesses through a node agent over WebSocket.
- Adapters emit normalized events (`packages/proto`): message chunks, tool call lifecycle, permission requests, usage, and per-LLM-call step events (model, latency, tokens in/out, cost, retries) for the trajectory view.
- Every event is saved to SQLite (`apps/server/data/truss.db`) and broadcast to all connected clients. Panels survive reloads, and every open device stays in sync.
- Terminal tabs are xterm.js in the web app, bound to node-pty sessions on the server.

## Plugin model

Two plugin kinds share one manifest (`plugin.json`):

- **adapter** adds a harness. It implements `spawn`, `send`, `events`, `interrupt`, and capability flags (permissions? subagents? streaming?).
- **panel** adds a UI panel. It ships a sandboxed iframe bundle (MCP Apps style) plus declared event subscriptions.

Built-in panels (trajectory, context, subagents, memory, skills, terminal) are plugins compiled into the default install. The core has no special cases.

## Event schema (proto)

ACP-aligned at the boundary, extended for our own needs:

- `session.*` for lifecycle, model, cwd, harness
- `msg.chunk` / `msg.done` for streamed text
- `tool.call` / `tool.update` / `tool.done` for pending → in progress → completed
- `perm.request` / `perm.resolve` for the permission card round trip
- `llm.call.start` / `llm.call.done` for per-API-call rows (the trajectory view)
- `subagent.spawn` / `subagent.done` for the team tree
- `ctx.usage` for context window occupancy by category
- `todo.upsert` / `feed.upsert` for the todos and feed stores (broadcast only, they persist in their own tables)
- `session.deleted` for hard deletes (also broadcast only)

## Why ACP at the boundary

It was built for "any editor talking to any agent": streamed chunks, tool call lifecycle, `session/request_permission`, elicitation, plan updates, usage and cost. Hermes already ships `hermes-acp`, pi's RPC mode maps one to one, and Claude Code's stream-json translates cleanly. See `docs/adapters.md`.

## Node-agent tunnel: protocol level and close codes (issue #217)

A remote host runs `packages/node-agent`, which dials out to the server over one WebSocket (`/agent/connect`) and speaks JSON frames. Both ends must agree on a **tunnel protocol level**. That level is a single constant, `TUNNEL_PROTOCOL` in **`packages/proto/src/tunnel.ts`** — the canonical source both the server and the node-agent import. It used to be two hand-maintained literals with nothing comparing them; it must never be two again.

**When to bump it:** in the same commit that changes the tunnel *wire format* — a frame added or removed, a field's meaning changed, anything that makes an older peer half-understand a newer one. Do **not** bump it for a server-side behavior change that rides fields both sides already send: installed agents never auto-update, so every bump marks every existing agent `outdated` and banners its host.

The handshake and the floor (all in `assessTunnelProtocol`):

| agent's `protocol` | verdict | server behavior |
| --- | --- | --- |
| below the server's | `older` | **accepted**; the host is marked `outdated` (a reinstall nudge, never a block — old agents keep working until a wire change forces a floor) |
| equal to the server's | `ok` | accepted, nothing flagged |
| above the server's | `newer` | **refused** with close code `4406` |
| absent (no field at all) | `older` | accepted as protocol 1 (a pre-handshake agent; this is NOT the junk case) |
| present but not a number | `junk` | **refused** with close code `4406` |

The absent-vs-junk split is deliberate and load-bearing: a protocol-1 agent that never sent the field currently connects and must keep connecting, while a field we cannot read means we cannot know what the peer speaks — and the server must never pretend it can speak a protocol it does not know. Refusal happens **before** the host registers, so a refused agent leaves no entry in the hosts registry.

Bundle-hash skew stays informational: the host detail view shows the agent's installed hash next to the server's current build.

### Close codes

Canonical table: `TUNNEL_CLOSE` in `packages/proto/src/tunnel.ts` — change it there, and the server, the agent, and this table stay in step. Codes 4400–4406 are the tunnel's own range.

| code | name | meaning | agent behavior |
| --- | --- | --- | --- |
| `4400` | `HELLO_FIRST` | the socket sent a frame before `hello` | reconnects (normal backoff) |
| `4403` | `UNAUTHORIZED` | bad, revoked, or rotated token | explains once, then checks every 60s |
| `4404` | `HOST_DELETED` | the host was deleted on the server | stops retrying, exits — retrying can never succeed |
| `4406` | `PROTOCOL_TOO_NEW` | the agent is newer than the server, or its protocol is unreadable | prints the mismatch, exits 1 — no retry loop |

A close reason is capped at 123 bytes on the wire (RFC 6455 §5.5.1); an over-long one makes the close frame throw and the peer hangs instead of learning why. `tunnelCloseReason()` truncates at that boundary, and the full explanation goes to the server log.
