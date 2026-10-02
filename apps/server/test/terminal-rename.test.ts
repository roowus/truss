import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for renamable shells — https://github.com/roowus/truss/issues/31
   ("Allow renaming shells"). These FAIL on purpose today: they pin the
   contract a fix must satisfy.

   Today a terminal's title is born at spawn (`bash projects`) and never
   changes — terminal.ts has createTerminal/listTerminals/closeTerminal but
   NO rename. The title flows to open tabs over the WS `hello` frame
   (TerminalPanel.tsx:68 calls api.setTitle from it), so a rename must push
   a frame to attached clients or open tabs never learn.

   The contract: terminal.ts gains

     renameTerminal(id, title): { id, title }

   - trims; empty/blank → throws (a nameless shell is worse than none);
     over-cap (64 chars) → throws;
   - unknown id → a clean "no such terminal" error;
   - listTerminals() reflects the new name immediately;
   - every ATTACHED client gets a { type: "title", title } frame, so an open
     terminal tab renames live without reattach;
   - cwd / alive / scrollback are untouched.

   The shells-list rename UI + route (POST /api/terminals/:id/rename) are
   acceptance criteria, not here. Tests spawn a real /bin/sh pty (cheap,
   same as api-terminals-ws.test.ts) and kill it in finally. */

interface TerminalModule {
  createTerminal(opts: { cwd?: string; shell?: string; title?: string }): { id: string; title: string };
  listTerminals(): { id: string; title: string; cwd: string; alive: boolean }[];
  closeTerminal(id: string): void;
  attachTerminal(id: string, socket: { send: (s: string) => void; on: (ev: string, fn: (d: unknown) => void) => void; close: () => void }): boolean;
  renameTerminal?(id: string, title: string): { id: string; title: string };
}

const terminal = (await import("../src/terminal.js")) as TerminalModule;

function fakeSocket(): { frames: any[]; socket: { send: (s: string) => void; on: () => void; close: () => void } } {
  const frames: any[] = [];
  return {
    frames,
    socket: {
      send: (s: string) => frames.push(JSON.parse(s)),
      on: () => {},
      close: () => {},
    },
  };
}

test("renameTerminal renames; listTerminals reflects it; cwd/alive untouched", () => {
  const t = terminal.createTerminal({ shell: "/bin/sh", cwd: "/tmp", title: "sh tmp" });
  try {
    assert.equal(typeof terminal.renameTerminal, "function", "terminal.ts must export renameTerminal(id, title) — see issue #31");

    const r = terminal.renameTerminal!(t.id, "  build shell  ");
    assert.equal(r.title, "build shell", "trimmed");
    const listed = terminal.listTerminals().find((x) => x.id === t.id)!;
    assert.equal(listed.title, "build shell", "the list shows the new name");
    assert.equal(listed.cwd, "/tmp", "cwd untouched");
    assert.equal(listed.alive, true, "liveness untouched");
  } finally {
    terminal.closeTerminal(t.id);
  }
});

test("attached clients get a title frame — open tabs rename live", () => {
  const t = terminal.createTerminal({ shell: "/bin/sh", cwd: "/tmp" });
  try {
    assert.equal(typeof terminal.renameTerminal, "function", "renameTerminal must exist (see rename test)");
    const { frames, socket } = fakeSocket();
    assert.equal(terminal.attachTerminal(t.id, socket), true);
    assert.equal(frames[0]?.type, "hello", "hello first (today's repaint path)");

    terminal.renameTerminal!(t.id, "deploy watcher");
    const titleFrame = frames.find((f) => f.type === "title");
    assert.ok(titleFrame, "a title frame must reach attached clients — hello only fires at attach");
    assert.equal(titleFrame.title, "deploy watcher");
  } finally {
    terminal.closeTerminal(t.id);
  }
});

test("validation: blank and over-long names rejected; unknown id errors cleanly", () => {
  const t = terminal.createTerminal({ shell: "/bin/sh", cwd: "/tmp" });
  try {
    assert.equal(typeof terminal.renameTerminal, "function", "renameTerminal must exist (see rename test)");
    assert.throws(() => terminal.renameTerminal!(t.id, ""), /title|empty|blank/i);
    assert.throws(() => terminal.renameTerminal!(t.id, "   \n "), /title|empty|blank/i);
    assert.throws(() => terminal.renameTerminal!(t.id, "x".repeat(65)), /long|64|characters/i, "tab titles need a cap");
    assert.throws(() => terminal.renameTerminal!("no-such-shell", "x"), /no such terminal|unknown|not found/i);
    /* the rejections changed nothing */
    assert.notEqual(terminal.listTerminals().find((x) => x.id === t.id)!.title, "");
  } finally {
    terminal.closeTerminal(t.id);
  }
});

test("a rename works on an exited-but-listed shell (its ghost tab stays renamable)", async () => {
  const t = terminal.createTerminal({ shell: "/bin/sh", cwd: "/tmp", title: "one-shot" });
  try {
    assert.equal(typeof terminal.renameTerminal, "function", "renameTerminal must exist (see rename test)");

    /* exit the pty through the real client path: attach, then send "exit" */
    const handlers = new Map<string, (d: unknown) => void>();
    const socket = {
      send: () => {},
      on: (ev: string, fn: (d: unknown) => void) => void handlers.set(ev, fn),
      close: () => {},
    };
    assert.equal(terminal.attachTerminal(t.id, socket), true);
    handlers.get("message")!(JSON.stringify({ type: "in", data: "exit\n" }));
    const deadline = Date.now() + 4000;
    while (terminal.listTerminals().find((x) => x.id === t.id)?.alive !== false && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(terminal.listTerminals().find((x) => x.id === t.id)?.alive, false, "the shell really exited");

    const r = terminal.renameTerminal!(t.id, "finished build");
    assert.equal(r.title, "finished build", "exited shells stay renamable while listed");
    assert.equal(terminal.listTerminals().find((x) => x.id === t.id)?.title, "finished build");
  } finally {
    terminal.closeTerminal(t.id);
  }
});

test("a client whose send throws (vanished mid-write) does not fail the rename nor starve later clients", () => {
  const t = terminal.createTerminal({ shell: "/bin/sh", cwd: "/tmp" });
  try {
    assert.equal(typeof terminal.renameTerminal, "function", "renameTerminal must exist (see rename test)");
    /* a socket that dies after attach, then a live one — the out/exit frames
       guard this same race with try/catch; the title frame must too */
    let gone = false;
    const dead = { send: () => { if (gone) throw new Error("socket closed"); }, on: () => {}, close: () => {} };
    const { frames, socket } = fakeSocket();
    assert.equal(terminal.attachTerminal(t.id, dead), true);
    assert.equal(terminal.attachTerminal(t.id, socket), true);
    gone = true;
    frames.length = 0;

    const r = terminal.renameTerminal!(t.id, "survived");
    assert.equal(r.title, "survived", "the rename succeeds despite the dead client");
    const titleFrame = frames.find((f) => f.type === "title");
    assert.ok(titleFrame, "clients after the dead one still get the title frame");
    assert.equal(titleFrame.title, "survived");
    assert.equal(terminal.listTerminals().find((x) => x.id === t.id)?.title, "survived");
  } finally {
    terminal.closeTerminal(t.id);
  }
});
