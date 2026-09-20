# Truss

**The head for your harnesses.**

Truss is a plugin-based, universal web frontend for AI agentic-loop harnesses. It is *not* a harness — it hosts them. Run Claude Code, DeepSeek Harness, pi, or Hermes side by side, pick a harness per chat, and watch every one of them through the same consistent interface: dockable tab windows, built-in terminals, an LLM trajectory view (the Chrome network tab for model calls), context tracking, subagent visualization, and more — all native panels, all plugins underneath.

## Status

Early scaffold. See [PLAN.md](./PLAN.md) and [docs/](./docs/) for the architecture and UI design contract. UI reference: `docs/mockups/variant-11-nocturne-abyss.html`.

## Stack

- **Web**: React 19 · Vite · Tailwind 4 · Dockview · xterm.js
- **Server**: Fastify (Node 22) · WebSocket event bus · SQLite
- **Protocol**: ACP at the harness boundary · internal event schema for per-LLM-call trajectory
- **Adapters**: `claude-code` · `hermes` · `pi` · `dsh`

## Develop

```bash
pnpm install
pnpm dev
```

## License

TBD (private until public release).
