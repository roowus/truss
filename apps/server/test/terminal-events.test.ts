import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for terminal lifecycle events — https://github.com/roowus/truss/issues/38
   ("Shells made through tabs don't show in the sidebar shell list").
   These FAIL on purpose today: they pin the contract a fix must satisfy.

   Root cause A (this file): terminal.ts has NO broadcaster — shells are
   born/renamed/killed silently. The sidebar list updates only in the client
   that made the change (store.refreshTerminals is client-local) or on a
   reconnect resync — so a shell created on another browser tab / device
   (the user runs rewvis + a MacBook) never appears until a reload. The
   feed and todos already have exactly this broadcaster seam
   (setFeedBroadcaster / setTodoBroadcaster); terminals need the same.

   The contract: terminal.ts gains

     setTerminalBroadcaster(fn: (ev: TerminalEvent) => void): void
     TerminalEvent = { type: "terminal.upsert", terminal: {id,title,cwd,alive} }
                   | { type: "terminal.deleted", id }

   - createTerminal → one terminal.upsert with the full row;
   - renameTerminal → one terminal.upsert with the new title (#31 composes);
   - closeTerminal → one terminal.deleted with the id;
   - FAILED operations (renaming a ghost) broadcast nothing.

   Root cause B (the create→silently-delete race in openFreeShell when the
   workspace isn't ready — "Workspace is still opening" + the shell is
   deleted) is acceptance criteria in the issue: the shell must survive and
   the open must queue/retry, not die. */

interface TerminalEvent {
  type: string;
  id?: string;
  terminal?: { id: string; title: string; cwd: string; alive: boolean };
}
interface TerminalModule {
  createTerminal(opts: { cwd?: string; shell?: string; title?: string }): { id: string; title: string };
  listTerminals(): { id: string; title: string; cwd: string; alive: boolean }[];
  closeTerminal(id: string): void;
  renameTerminal?(id: string, title: string): { id: string; title: string };
  attachTerminal(id: string, socket: { send: (s: string) => void; on: (ev: string, fn: (d: unknown) => void) => void; close: () => void }): boolean;
  setTerminalBroadcaster?(fn: (ev: TerminalEvent) => void): void;
}

const terminal = (await import("../src/terminal.js")) as TerminalModule;

function wire(): TerminalEvent[] {
  const frames: TerminalEvent[] = [];
  assert.equal(typeof terminal.setTerminalBroadcaster, "function", "terminal.ts must export setTerminalBroadcaster — see issue #38");
  terminal.setTerminalBroadcaster!((ev) => frames.push(ev));
  return frames;
}

test("createTerminal broadcasts terminal.upsert with the full row", () => {
  const frames = wire();
  const t = terminal.createTerminal({ shell: "/bin/sh", cwd: "/tmp", title: "birthday shell" });
  try {
    const up = frames.filter((f) => f.type === "terminal.upsert");
    assert.equal(up.length, 1, "exactly one upsert per create");
    assert.deepEqual(
      { id: up[0].terminal?.id, title: up[0].terminal?.title, cwd: up[0].terminal?.cwd, alive: up[0].terminal?.alive },
      { id: t.id, title: "birthday shell", cwd: "/tmp", alive: true },
    );
  } finally {
    terminal.setTerminalBroadcaster!(undefined as never);
    terminal.closeTerminal(t.id);
  }
});

test("renameTerminal broadcasts the new title over the bus (every client, not just the renamer)", () => {
  const frames = wire();
  const t = terminal.createTerminal({ shell: "/bin/sh", cwd: "/tmp" });
  try {
    assert.equal(typeof terminal.renameTerminal, "function", "renameTerminal (#31) must exist for this composition");
    frames.length = 0;
    terminal.renameTerminal!(t.id, "renamed on the bus");
    const up = frames.filter((f) => f.type === "terminal.upsert");
    assert.equal(up.length, 1);
    assert.equal(up[0].terminal?.title, "renamed on the bus");
  } finally {
    terminal.setTerminalBroadcaster!(undefined as never);
    terminal.closeTerminal(t.id);
  }
});

test("closeTerminal broadcasts terminal.deleted; failed ops broadcast nothing", () => {
  const frames = wire();
  const t = terminal.createTerminal({ shell: "/bin/sh", cwd: "/tmp" });
  frames.length = 0;
  terminal.closeTerminal(t.id);
  const del = frames.filter((f) => f.type === "terminal.deleted");
  assert.equal(del.length, 1, "exactly one deletion frame");
  assert.equal(del[0].id, t.id);
  assert.equal(frames.filter((f) => f.type === "terminal.upsert").length, 0, "no upsert on the way out");

  frames.length = 0;
  assert.throws(() => terminal.renameTerminal?.("ghost-shell", "x"), /no such terminal|unknown|not found/i);
  assert.deepEqual(frames, [], "a rejected rename is silent on the bus");
});

test("a terminal that exits on its own broadcasts an upsert with alive=false", async () => {
  const frames = wire();
  const t = terminal.createTerminal({ shell: "/bin/sh", cwd: "/tmp" }); // sh -c exit: spawn, then die
  try {
    /* ask the pty to exit via the client input path */
    const handlers = new Map<string, (d: unknown) => void>();
    terminal.attachTerminal(t.id, { send: () => {}, on: (ev, fn) => void handlers.set(ev, fn), close: () => {} });
    handlers.get("message")!(JSON.stringify({ type: "in", data: "exit\n" }));

    const deadline = Date.now() + 4000;
    let dead: TerminalEvent | undefined;
    while (Date.now() < deadline && !dead) {
      dead = frames.find((f) => f.type === "terminal.upsert" && f.terminal?.id === t.id && f.terminal?.alive === false);
      if (!dead) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(dead, "a natural exit flips alive=false on the bus — sidebars must show the red ghost without a reload");
  } finally {
    terminal.setTerminalBroadcaster!(undefined as never);
    terminal.closeTerminal(t.id);
  }
});

test("a deliberate close never re-adds the shell as a ghost (kill fires exit async — after the deleted frame)", async () => {
  const frames = wire();
  const t = terminal.createTerminal({ shell: "/bin/sh", cwd: "/tmp", title: "no ghost" });
  frames.length = 0;
  terminal.closeTerminal(t.id);
  /* let the killed pty's exit event land — the bug upserted a ghost here */
  await new Promise((r) => setTimeout(r, 600));
  const events = frames.map((f) => f.type);
  assert.deepEqual(events, ["terminal.deleted"], "exactly one deleted frame and nothing after it");
  terminal.setTerminalBroadcaster!(undefined as never);
});
