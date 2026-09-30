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
  /** deliberately closed — the dying pty's exit must NOT re-upsert a ghost
     after the deleted frame (closeTerminal kills, exit fires async after) */
  closing?: boolean;
}

const terms = new Map<string, Term>();

/* the bus (issue #38): shells are app-global — every client learns of births,
   renames, deaths without a reload. Same broadcaster seam as feed/todos. */
type TerminalEvent =
  | { type: "terminal.upsert"; sessionId: string; terminal: { id: string; title: string; cwd: string; alive: boolean } }
  | { type: "terminal.deleted"; sessionId: string; id: string };

let broadcaster: ((ev: TerminalEvent) => void) | null = null;
export function setTerminalBroadcaster(fn: ((ev: TerminalEvent) => void) | null) {
  broadcaster = fn;
}
const emitUp = (t: Term) =>
  broadcaster?.({ type: "terminal.upsert", sessionId: "", terminal: { id: t.id, title: t.title, cwd: t.cwd, alive: t.alive } });
const emitDel = (id: string) => broadcaster?.({ type: "terminal.deleted", sessionId: "", id });

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
    if (!t.closing) emitUp(t); /* natural exit: sidebars show the red ghost; a deliberate close already said deleted */
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
  emitUp(t);
  return { id, title: t.title };
}

/** rename a shell (issue #31): trimmed, 1..64 chars; attached clients get a
   {type:"title"} frame so open tabs rename live without reattach */
export function renameTerminal(id: string, title: string): { id: string; title: string } {
  const t = terms.get(id);
  if (!t) throw new Error(`no such terminal: ${id}`);
  const clean = String(title ?? "").trim();
  if (!clean) throw new Error("title must not be empty");
  if (clean.length > 64) throw new Error("title too long (64 characters max)");
  t.title = clean;
  for (const c of t.clients) c.send(JSON.stringify({ type: "title", title: clean }));
  emitUp(t); /* every client, not just attached ones */
  return { id, title: clean };
}

export function listTerminals() {
  return [...terms.values()].map((t) => ({ id: t.id, title: t.title, cwd: t.cwd, alive: t.alive }));
}

export function closeTerminal(id: string) {
  const t = terms.get(id);
  if (!t) return;
  t.closing = true;
  try {
    t.pty.kill();
  } catch {
    /* already dead */
  }
  terms.delete(id);
  emitDel(id);
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
