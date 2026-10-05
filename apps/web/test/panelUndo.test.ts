import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeClosed,
  freshPanels,
  isUndoablePanel,
  panelDescriptor,
  panelsEntry,
  popClosed,
  pushClosed,
  restoreSpaceId,
  suppressionKey,
  type ClosedEntry,
  type PanelDescriptor,
} from "../src/lib/workspaceClose";

/* Spec tests for panel-level undo — https://github.com/roowus/truss/issues/124
   ("Reopen closed tabs and tab groups, like Chrome's Cmd+Shift+T"). PR #120
   made Cmd+Shift+T reopen whole WORKSPACES; this pins the same undo for the
   per-tab X and the group-corner X: closed panels are captured as descriptors
   (id, component, title, params — the shape transferPanel re-adds) and share
   ONE mixed LIFO stack with workspace closes. */

const descriptor = (id: string, title = id): PanelDescriptor => ({
  id,
  component: id.split(":")[0],
  tabComponent: "truss",
  title,
});

test("panelDescriptor captures the transferPanel shape: id, component, tabComponent, title, params", () => {
  const panel = {
    id: "chat:sess-1",
    title: "Refactor the parser",
    params: { sessionId: "sess-1" },
    toJSON: () => ({ contentComponent: "chat", tabComponent: "truss", params: { sessionId: "sess-1" }, title: "Refactor the parser" }),
  };
  assert.deepEqual(panelDescriptor(panel), {
    id: "chat:sess-1",
    component: "chat",
    tabComponent: "truss",
    title: "Refactor the parser",
    params: { sessionId: "sess-1" },
  });
});

test("panelDescriptor falls back like transferPanel: component from the id prefix, tabComponent truss", () => {
  const bare = { id: "terminal:abc-123", toJSON: () => ({}) };
  const d = panelDescriptor(bare);
  assert.equal(d.component, "terminal", "no contentComponent → the id's kind prefix");
  assert.equal(d.tabComponent, "truss");
  assert.equal(d.title, "");
  assert.equal(d.params, undefined);
});

test("isUndoablePanel: the welcome tab is machinery (auto-closed when a chat opens), never undoable", () => {
  assert.equal(isUndoablePanel("welcome"), false);
  assert.equal(isUndoablePanel("chat:s1"), true);
  assert.equal(isUndoablePanel("terminal:t1"), true);
  assert.equal(isUndoablePanel("settings"), true);
});

test("one mixed LIFO stack: tabs, groups, and workspaces interleave, most recent first", () => {
  let stack: ClosedEntry[] = [];
  stack = pushClosed(stack, { type: "workspace", name: "research", layout: { panels: {} }, at: 1 });
  stack = pushClosed(stack, { type: "panels", spaceId: "main", panels: [descriptor("chat:s1", "Chat")] , at: 2 });
  stack = pushClosed(stack, { type: "panels", spaceId: "main", panels: [descriptor("git:s1", "Git"), descriptor("tasks:s1", "Tasks")], at: 3 });

  const first = popClosed(stack);
  assert.equal(first?.snapshot.type, "panels", "the group close is on top");
  assert.equal(first?.snapshot.type === "panels" && first.snapshot.panels.length, 2, "a closed group comes back as ONE entry");
  const second = popClosed(first!.rest);
  assert.equal(second?.snapshot.type, "panels");
  const third = popClosed(second!.rest);
  assert.equal(third?.snapshot.type, "workspace", "the workspace close sits under both tab closes");
  assert.equal(popClosed(third!.rest), null);

  /* the cap bounds the mixed stack as a whole (25 — Chrome's neighborhood,
     revisited when tab closes joined the stack) */
  let big: ClosedEntry[] = [];
  for (let i = 0; i < 30; i++) big = pushClosed(big, { type: "panels", spaceId: "main", panels: [descriptor(`chat:s${i}`)], at: i });
  assert.ok(big.length <= 25, `bounded (got ${big.length})`);
});

test("describeClosed names the palette/chord target for each entry kind", () => {
  assert.equal(describeClosed({ type: "workspace", name: "ops", layout: null, at: 1 }), "Reopen closed workspace: ops");
  assert.equal(
    describeClosed({ type: "panels", spaceId: "main", panels: [descriptor("chat:s1", "Refactor the parser")], at: 1 }),
    "Reopen closed tab: Refactor the parser",
  );
  assert.equal(
    describeClosed({ type: "panels", spaceId: "main", panels: [descriptor("chat:s1", "A"), descriptor("git:s1", "B"), descriptor("feed", "C")], at: 1 }),
    "Reopen 3 closed tabs",
  );
  /* an untitled tab still gets a readable label */
  assert.equal(describeClosed({ type: "panels", spaceId: "main", panels: [{ ...descriptor("terminal:t9"), title: "" }], at: 1 }), "Reopen closed tab: terminal:t9");
});

test("restoreSpaceId: back where it closed, unless that workspace is gone or archived", () => {
  const spaces = [{ id: "main" }, { id: "desk-2" }, { id: "desk-3", archived: true }];
  const entry = { type: "panels" as const, spaceId: "desk-2", panels: [descriptor("chat:s1")], at: 1 };
  assert.equal(restoreSpaceId(entry, spaces, "main"), "desk-2", "same workspace when it still lives");
  assert.equal(restoreSpaceId({ ...entry, spaceId: "ghost" }, spaces, "main"), "main", "closed-workspace tabs land on the ACTIVE workspace");
  assert.equal(restoreSpaceId({ ...entry, spaceId: "desk-3" }, spaces, "main"), "main", "archived workspaces stay hidden — restore to the active one");
});

test("freshPanels: tabs the user already re-opened by hand are skipped, order kept", () => {
  const panels = [descriptor("chat:s1", "A"), descriptor("git:s1", "B"), descriptor("tasks:s1", "C")];
  const exists = (id: string) => id === "git:s1";
  assert.deepEqual(freshPanels(panels, exists).map((p) => p.id), ["chat:s1", "tasks:s1"]);
  assert.deepEqual(freshPanels(panels, () => true), [], "all alive → nothing to re-add");
  assert.deepEqual(freshPanels([], () => false), []);
});

/* PR #128 audit round 1, B3: pin the extracted seam the DOM-coupled wiring
   (desktops.recordPanelClose / closeGroup) is built on — the same pattern as
   terminalIdsInLayout for teardown. */

test("panelsEntry: a close gesture becomes ONE entry; machinery-only gestures vanish", () => {
  const panel = (id: string, title = id) => ({
    id,
    title,
    params: { sessionId: "s1" },
    toJSON: () => ({ contentComponent: id.split(":")[0], tabComponent: "truss" }),
  });

  const single = panelsEntry("main", [panel("chat:s1", "Chat")], 42);
  assert.equal(single?.type, "panels");
  assert.equal(single?.spaceId, "main");
  assert.equal(single?.at, 42);
  assert.deepEqual(single?.panels.map((p) => p.id), ["chat:s1"]);

  const group = panelsEntry("desk-2", [panel("chat:s1"), panel("welcome"), panel("git:s1")], 7);
  assert.deepEqual(group?.panels.map((p) => p.id), ["chat:s1", "git:s1"], "welcome is filtered out of a group close");

  assert.equal(panelsEntry("main", [panel("welcome")], 1), null, "a gesture that closes only machinery leaves NO phantom undo");
  assert.equal(panelsEntry("main", [], 1), null);
});

test("suppressionKey: the workspace scopes the key (panel ids repeat across workspaces)", () => {
  assert.notEqual(suppressionKey("main", "chat:s1"), suppressionKey("desk-2", "chat:s1"));
  assert.equal(suppressionKey("main", "chat:s1"), suppressionKey("main", "chat:s1"));
  assert.ok(suppressionKey("main", "terminal:abc").includes("terminal:abc"));
});
