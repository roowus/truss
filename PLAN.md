# Truss — Plan

## What this is

A plugin-based, universal **frontend ("head") for AI agentic-loop harnesses** — not a harness itself. Truss hosts harnesses (Claude Code, DeepSeek Harness, pi, Hermes to start), lets the user run each chat on a chosen harness, and renders all of them in one consistent UI.

Core UI: sidebar (project-grouped sessions, harnesses, panels) + **dockable/tileable workspace** — tabs hold chats, terminals, or any panel; windows split horizontally and vertically (up to quarters); every window has its own tab bar.

Native (pre-installed plugin) panels: context tracker, subagent/team visualization, task list, built-in terminal, **trajectory** (Chrome network tab for LLM calls), skills, memory.

## Locked decisions

- **Form factor** — web app (local server + browser, tailnet-reachable from all devices). Optional Tauri/Electron shell later.
- **Adapter model** — headless/structured per harness; no PTY scraping in v1.
- **Protocol** — ACP (Agent Client Protocol) at the harness boundary; internal event bus with per-LLM-call step events for trajectory; MCP Apps model for third-party plugin panels (sandboxed iframes).
- **Persistence** — backend owns a SQLite store (sessions, transcripts, trajectory events, layout state). Mirrors harness data.
- **Plugins, two levels** — harness adapters + UI panels, same manifest API.
- **Interactivity** — bidirectional: user prompts AND agent→user permission/question cards.
- **Remote-capable** — harnesses run behind a node-agent daemon (local = same box; remote = Fedora / rewvis over tailnet). Coded for from day 1.
- **UI reference** — `docs/mockups/variant-11-nocturne-abyss.html`. See `docs/ui-design.md`.

## Milestones

| M | Goal |
|---|---|
| M0 | Scaffold: repo, monorepo, server health, Dockview shell rendering the v11 look, CI |
| M1 | First harness end-to-end: **pi** adapter (RPC mode) — chat, stream, persist, trajectory rows |
| M2 | Terminals: xterm.js + node-pty tabs |
| M3 | **Hermes** adapter (hermes-acp over stdio) + permission cards |
| M4 | **Claude Code** adapter (stream-json, `--permission-prompt-tool` → permission host) |
| M5 | Native panels: trajectory detail, context tracker, subagents, memory |
| M6 | **DSH** adapter via SSH bridge to rewvis |
| M7 | Node-agent for remote hosts · Tauri shell · mobile-responsive pass |

## Docs

- [docs/architecture.md](./docs/architecture.md) — system layout, event flow, packages
- [docs/adapters.md](./docs/adapters.md) — per-harness integration contract
- [docs/ui-design.md](./docs/ui-design.md) — design tokens + UI patterns (the v11 contract)
