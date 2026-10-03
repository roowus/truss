import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { spawn as ptySpawn, type IPty } from "node-pty";

/**
 * Terminal manager — node-pty shells behind a WS channel.
 * Scrollback lives in a per-terminal ring buffer so late/re- attaching
 * clients repaint instantly. Shells die with the server; nothing persists.
 */

const SCROLLBACK_CAP = 128 * 1024; // bytes of utf-8 output kept per terminal

interface Term {
  id: string;
  title: string;
  cwd: string;
  pty: IPty;
  scrollback: string;
  clients: Set<{ send: (s: string) => void }>;
  alive: boolean;
  /* in-memory like the shell itself (issue #86): a dead shell's pin would
     mean nothing, so the flag dies with the server */
  pinned: boolean;
}

const terms = new Map<string, Term>();

export function createTerminal(opts: { cwd?: string; shell?: string; title?: string }): {
  id: string;
  title: string;
} {
  const shell = opts.shell || process.env.SHELL || "/bin/bash";
  const cwd = opts.cwd || process.env.HOME || "/";
  const id = randomUUID().slice(0, 8);
  const pty = ptySpawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  });

  const t: Term = {
    id,
    title: opts.title || `${basename(shell)} ${basename(cwd)}`,
    cwd,
    pty,
    scrollback: "",
    clients: new Set(),
    alive: true,
    pinned: false,
  };

  pty.onData((data) => {
    t.scrollback = (t.scrollback + data).slice(-SCROLLBACK_CAP);
    const frame = JSON.stringify({ type: "out", data });
    for (const c of t.clients) {
      try {
        c.send(frame);
      } catch {
        /* client vanished mid-write */
      }
    }
  });

  pty.onExit(({ exitCode }) => {
    t.alive = false;
    const frame = JSON.stringify({ type: "exit", code: exitCode });
    for (const c of t.clients) {
      try {
        c.send(frame);
      } catch {
        /* gone */
      }
    }
  });

  terms.set(id, t);
  return { id, title: t.title };
}

export function listTerminals() {
  return [...terms.values()].map((t) => ({ id: t.id, title: t.title, cwd: t.cwd, alive: t.alive, pinned: t.pinned }));
}

/** pin/unpin (issue #86) — floats the shell to the top of the sidebar's
    shells section. No persistence: shells die with the server, so does the
    pin. When the #38 lifecycle bus lands, this is where a pin rides a
    terminal.upsert frame. */
export function setTerminalPinned(id: string, pinned: boolean) {
  const t = terms.get(id);
  if (!t) throw new Error(`no such terminal: ${id}`);
  t.pinned = pinned;
}

/** rename a shell and push a title frame so attached tabs repaint live.
   Exited-but-listed shells stay renamable — their ghost tabs deserve real
   names too. Titles stay per-server-session; nothing persists. */
export function renameTerminal(id: string, title: string): { id: string; title: string } {
  const t = terms.get(id);
  if (!t) throw new Error(`no such terminal: ${id}`);
  const trimmed = title.trim().slice(0, 64);
  if (!trimmed) throw new Error("title must not be blank");
  t.title = trimmed;
  const frame = JSON.stringify({ type: "title", title: t.title });
  for (const c of t.clients) {
    try {
      c.send(frame);
    } catch {
      /* client vanished mid-write */
    }
  }
  return { id, title: t.title };
}

export function closeTerminal(id: string) {
  const t = terms.get(id);
  if (!t) return;
  try {
    t.pty.kill();
  } catch {
    /* already dead */
  }
  terms.delete(id);
}

/** Wire one WS socket to a terminal: replay scrollback, then pipe both ways. */
export function attachTerminal(id: string, socket: { send: (s: string) => void; on: (ev: string, fn: (d: unknown) => void) => void; close: () => void }): boolean {
  const t = terms.get(id);
  if (!t) return false;
  const client = { send: (s: string) => socket.send(s) };
  t.clients.add(client);

  socket.send(JSON.stringify({ type: "hello", title: t.title, alive: t.alive }));
  if (t.scrollback) socket.send(JSON.stringify({ type: "out", data: t.scrollback }));

  socket.on("message", (raw: unknown) => {
    let msg: { type?: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "in" && typeof msg.data === "string" && t.alive) {
      t.pty.write(msg.data);
    } else if (msg.type === "resize" && msg.cols && msg.rows) {
      try {
        t.pty.resize(msg.cols, msg.rows);
      } catch {
        /* pty gone */
      }
    }
  });

  socket.on("close", () => {
    t.clients.delete(client);
  });
  return true;
}
