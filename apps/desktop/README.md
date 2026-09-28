# @truss/desktop — Tauri shell

A thin native shell around the hosted Truss UI. It opens a single window
pointed at the Truss server (default `http://127.0.0.1:4040`) — the server does
everything; the shell is just frame, menu, and keymap.

## Why a shell at all

- Own window/app icon/cmd-tab entry instead of a browser tab
- Native menu + shortcuts (⌘N new session, ⌘W close tab) without browser chrome
- Optional later: local-first mode that also spawns a bundled `truss` server
  binary when offline (not wired yet — see "Local mode" below)

## Build (on the Mac)

```bash
# once: rust + tauri prereqs — https://v2.tauri.app/start/prerequisites/
pnpm install
pnpm --filter @truss/desktop tauri build     # produces .app in apps/desktop/src-tauri/target/release/bundle
```

Point it at a different server without rebuilding:

```bash
TRUSS_URL=http://127.0.0.1:4040 open -a Truss
```

## Files

- `src-tauri/tauri.conf.json` — app identity, single main window
- `src-tauri/src/main.rs` — creates the window at `TRUSS_URL` (env) / `http://127.0.0.1:4040` (default)
- `src-tauri/Cargo.toml` — one dependency: `tauri`
- `package.json` — the `tauri` CLI wrapper

## Local mode (future)

The intended full form: Tauri sidecar spawns `apps/server` locally when the
remote is unreachable, falling back to `http://127.0.0.1:4040`. That needs a
compiled server bundle (single-file node build) — tracked as a later M7 item.
