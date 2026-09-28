# @truss/desktop: Tauri shell

A thin native shell around the hosted Truss UI. It opens a single window
pointed at the Truss server (default `http://127.0.0.1:4040`). The server does
everything; the shell is just frame, menu, and keymap.

## Why a shell at all

- Own window, app icon, and cmd-tab entry instead of a browser tab
- Native menu and shortcuts (⌘N new session, ⌘W close tab) without browser chrome
- Maybe later: a local-first mode that spawns a bundled `truss` server binary
  when the remote is unreachable (not wired yet, see "Local mode" below)

## Build (on the Mac)

```bash
# once: rust + tauri prereqs, see https://v2.tauri.app/start/prerequisites/
pnpm install
pnpm --filter @truss/desktop tauri build     # produces the .app in apps/desktop/src-tauri/target/release/bundle
```

Point it at a different server without rebuilding:

```bash
TRUSS_URL=http://127.0.0.1:4040 open -a Truss
```

## Files

- `src-tauri/tauri.conf.json`: app identity, single main window
- `src-tauri/src/main.rs`: creates the window at `TRUSS_URL` (env) or `http://127.0.0.1:4040` (default)
- `src-tauri/Cargo.toml`: one dependency, `tauri`
- `package.json`: the `tauri` CLI wrapper

## Local mode (future)

The full form: a Tauri sidecar spawns `apps/server` locally when the remote is
unreachable, falling back to `http://127.0.0.1:4040`. That needs a compiled
single-file server bundle, tracked as a later M7 item.
