# Truss

**The head for your harnesses.**

Truss is a web frontend for AI agent harnesses. It is not a harness itself, it hosts them. Run [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code), [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh), and Hermes side by side, pick a harness per chat, and watch all of them through the same interface. You get dockable tab windows, real terminals, a trajectory view that works like the Chrome network tab but for model calls, context tracking, a subagent tree, a task board, todos, and an inbox for things agents hand back to you.

![Truss workspace](docs/screenshots/workspace.png)

> [!WARNING]
> **Truss is very beta.** One person builds it and it moves fast. Expect
> breaking changes between commits, rough edges, and migrations that might
> not be graceful. **Do not put it on the public internet** (see
> [Security model](#security-model)). Back up `apps/server/data/` if you care
> about what's in it. That said, it is a real working app that gets used
> every day, and issues and PRs are welcome.

## What you get

- **Every harness in one UI.** Chat, streaming, interrupt, permission cards, and dead sessions that resume with their history intact.
- **A real workspace.** Split panes any direction, each pane has its own tab bar, tabs drag between panes and between workspaces (think virtual desktops), and the layout persists. Tabs shrink to fit like Chrome; the close button shows on hover, or sits inline when there's room.
- **Trajectory.** Every LLM call with model, latency, tokens, cost (cache reads and writes too). Expand a call to see the tools that ran inside it. Retries and failures stand out.
- **Feed.** Your inbox. Permission requests you can answer from the card, finished-work notes, crashes, context-window warnings, and reports agents post. Sort, filter, save, dismiss, or share a card into another agent's chat.
- **Todos.** Agents file tasks for you (the `file_todo` tool) with priority, deadline, labels, subtasks, and estimates. Four views: grouped list, priority board, table, deadline calendar. A session can only edit its own todos unless you approve an access card.
- **Tasks board.** A kanban of prompts you run as sessions. Agents can file and run cards through the `mcp__truss__*` tools too.
- **Terminals.** Real shells (xterm.js + node-pty) in tabs. Free shells, or a shell in a session's working directory.
- **Files, Git, Skills.** Browse and edit the workspace tree. Branch switcher, changes with diffs, commit graph. A skill explorer with enable/disable, create, and trash.
- **Context, Team, Cost, Credentials, Router, Hosts.** Occupancy gauges, subagent trees, a cost ledger with a daily heat grid, and management UIs for a local key proxy, a model router, and remote node agents.
- **TRUSS.md practices.** Like CLAUDE.md but for Truss. A global file plus per-project and per-folder layers, handed to agents so they follow your coding and posting conventions.
- **Live sync.** The event bus has a heartbeat and reconnects cleanly. Open it on two devices and both stay current.
- **Agents can drive Truss itself.** Sessions, prompts, terminals, tasks, todos, feed, workspaces, and layout are all MCP tools (`POST /mcp/truss`).

<p float="left">
  <img src="docs/screenshots/feed.png" width="360" alt="Feed, the inbox" />
  <img src="docs/screenshots/todos.png" width="360" alt="Todos, tasks filed by agents" />
</p>

## Setup

**You need:** Node.js 22 or newer, pnpm (`corepack enable && corepack prepare pnpm@latest`), and at least one harness CLI on your `PATH` (`pi`, `claude`, `dsh`, or `hermes`) with working models.

```bash
git clone https://github.com/roowus/truss.git
cd truss
pnpm install

# dev: fastify on :4040 (tsx watch) + vite on :4041 (proxies /api and /events)
pnpm dev
# open http://127.0.0.1:4041
```

**No harnesses handy?** Add `?demo` to the URL. The whole UI runs in the browser against a fake backend that speaks the real event contract.

**Running it for real:**

```bash
pnpm -C apps/web build      # builds the single-file web app into apps/web/dist
pnpm -C apps/server start   # serves the app + REST + WS on 127.0.0.1:4040
```

**Environment variables:**

| Var | Default | What it does |
|---|---|---|
| `TRUSS_PORT` | `4040` | server port |
| `TRUSS_HOST` | `0.0.0.0` | bind address |
| `TRUSS_DATA_DIR` | `apps/server/data` | where the SQLite store lives (sessions, transcripts, todos, feed, layout) |
| `TRUSS_AGENT_TOKEN` | `truss-dev` | shared secret for remote node agents |
| `TRUSS_WEB_DIST` | `apps/web/dist` | override the served web build |

**Multiple devices:** serve it over your private network (tailscale serve, your LAN, an SSH tunnel). All devices stay in sync on their own.

**Import existing DSH sessions:** `POST /api/import/dsh` (there's a sidebar button) imports saved DeepSeek Harness sessions with transcripts and resume refs.

## Security model

Truss is a **single-user, fully trusted** local app. The server has **no auth at all**, and agents can run shell commands by design. Bind to loopback or your private network only. Do not expose it publicly without putting real auth in front of it.

## Stack and docs

- Web: React 19, Vite, Tailwind 4, Dockview, xterm.js (single-file build)
- Server: Fastify (Node 22), WebSocket event bus, SQLite (better-sqlite3)
- Protocol: ACP at the harness boundary, plus an internal event schema (`packages/proto`)
- [docs/architecture.md](./docs/architecture.md) has the system layout and data flow
- [docs/adapters.md](./docs/adapters.md) has the per-harness integration notes
- [docs/ui-handoff-v2.md](./docs/ui-handoff-v2.md) is the UI redesign brief
- [PLAN.md](./PLAN.md) is the milestone log

## License

[MIT](./LICENSE) © 2026 roowus
