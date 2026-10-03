import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for pinning shells (and the hosts flag) —
   https://github.com/roowus/truss/issues/86
   ("Add pinning: chats, shells, etc."). These FAIL on purpose today.

   Shells are in-memory (they die with the server), so the pin is too —
   honest by construction. Hosts persist, so theirs is a column.

   The contract:
   - terminal.ts gains setTerminalPinned(id, pinned); listTerminals carries
     pinned; unknown id throws; when the #38 lifecycle bus is present, a pin
     rides a terminal.upsert frame (composes, doesn't require);
   - hosts.ts gains setHostPinned(id, pinned) (mirrors setHostRevoked);
     listHosts carries pinned; unknown id throws. */

test("setTerminalPinned toggles the shell's pin; list carries it; ghosts throw", () => {
  return (async () => {
    const terminal: any = await import("../src/terminal.js");
    assert.equal(typeof terminal.setTerminalPinned, "function", "terminal.ts must export setTerminalPinned — see issue #86");

    const t = terminal.createTerminal({ shell: "/bin/sh", cwd: "/tmp", title: "pin me" });
    try {
      assert.equal(terminal.listTerminals().find((x: any) => x.id === t.id).pinned ?? false, false, "unpinned by default");
      terminal.setTerminalPinned(t.id, true);
      assert.equal(terminal.listTerminals().find((x: any) => x.id === t.id).pinned, true, "pinned");
      terminal.setTerminalPinned(t.id, false);
      assert.equal(terminal.listTerminals().find((x: any) => x.id === t.id).pinned, false, "unpinned again");
      assert.throws(() => terminal.setTerminalPinned("ghost", true), /no such terminal|unknown|not found/i);
    } finally {
      terminal.closeTerminal(t.id);
    }
  })();
});

test("setHostPinned toggles the host's pin; listHosts carries it; ghosts throw", async () => {
  const { freshServer } = await import("./helpers.js");
  const { cleanup } = await freshServer("host-pin");
  try {
    const hosts: any = await import("../src/hosts.js");
    assert.equal(typeof hosts.setHostPinned, "function", "hosts.ts must export setHostPinned — see issue #86");

    const { host } = hosts.createHost("pin-target box");
    assert.equal(hosts.listHosts().find((h: any) => h.id === host.id).pinned ?? false, false, "unpinned by default");
    hosts.setHostPinned(host.id, true);
    assert.equal(hosts.listHosts().find((h: any) => h.id === host.id).pinned, true, "pinned");
    hosts.setHostPinned(host.id, false);
    assert.equal(hosts.listHosts().find((h: any) => h.id === host.id).pinned, false);
    assert.throws(() => hosts.setHostPinned("ghost", true), /no such|unknown|not found/i);
  } finally {
    cleanup();
  }
});

test("a pin rides the terminal bus when it exists (composes with the #38 lifecycle frames)", async () => {
  const terminal: any = await import("../src/terminal.js");
  assert.equal(typeof terminal.setTerminalPinned, "function", "setTerminalPinned must exist (see pin test)");
  if (typeof terminal.setTerminalBroadcaster !== "function") {
    /* the #38 bus hasn't landed on this branch — the composition is inert
       until it does; the pin itself must still work */
    const t = terminal.createTerminal({ shell: "/bin/sh", cwd: "/tmp" });
    terminal.setTerminalPinned(t.id, true);
    assert.equal(terminal.listTerminals().find((x: any) => x.id === t.id).pinned, true);
    terminal.closeTerminal(t.id);
    return;
  }
  const frames: any[] = [];
  terminal.setTerminalBroadcaster((ev: any) => frames.push(ev));
  try {
    const t = terminal.createTerminal({ shell: "/bin/sh", cwd: "/tmp" });
    frames.length = 0;
    terminal.setTerminalPinned(t.id, true);
    const up = frames.find((f) => f.type === "terminal.upsert" && f.terminal?.id === t.id);
    assert.ok(up, "a pin broadcasts an upsert (every client's sidebar reorders live)");
    assert.equal(up.terminal.pinned, true, "carrying the flag");
    terminal.closeTerminal(t.id);
  } finally {
    terminal.setTerminalBroadcaster(undefined as never);
  }
});
