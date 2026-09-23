# Truss

**The head for your harnesses.**

Truss is a plugin-based, universal web frontend for AI agentic-loop harnesses. It is *not* a harness — it hosts them. Run Claude Code, DeepSeek Harness, pi, or Hermes side by side, pick a harness per chat, and watch every one of them through the same consistent interface: dockable tab windows, built-in terminals, an LLM trajectory view (the Chrome network tab for model calls), context tracking, subagent visualization, and more — all native panels, all plugins underneath.

## Status

Working app. pi and DeepSeek Harness adapters are live end-to-end (chat, streaming, tools, trajectory, terminals, native panels). See [PLAN.md](./PLAN.md) and [docs/](./docs/) for the architecture and UI design contract. UI reference: `docs/mockups/variant-11-nocturne-abyss.html`.

## Stack

- **Web**: React 19 · Vite · Tailwind 4 · Dockview · xterm.js
- **Server**: Fastify (Node 22) · WebSocket event bus · SQLite
- **Protocol**: ACP at the harness boundary · internal event schema for per-LLM-call trajectory
- **Adapters**: `claude-code` · `hermes` · `pi` · `dsh`

## Develop

```bash
pnpm install
pnpm dev        # fastify :4040 (tsx watch) + vite :4041 (proxy)
```

On rewvis the systemd `truss.service` owns :4040 — stop it (`sudo systemctl stop truss`) before running a dev server, or set `TRUSS_PORT` to something free.

## Hosted (rewvis)

Truss is hosted at **https://truss.rewis** (tailnet-only, Caddy `tls internal` like the other `*.rewis` sites).

- `truss.service` runs the Fastify server (`tsx apps/server/src/index.ts`), which serves the built web app from `apps/web/dist` plus `/api`, `/events` (WS), and `/api/terminal/:id/ws` on `127.0.0.1:4040`.
- Caddy proxies `truss.rewis` → `127.0.0.1:4040` (`/etc/caddy/Caddyfile`).
- Deploy an update: `pnpm -C apps/web build && sudo systemctl restart truss`.
- If `truss.rewis` doesn't resolve on a device, add `100.107.125.118 truss.rewis` to its hosts file (same mechanism as the other `*.rewis` names).

## License

TBD (private until public release).
