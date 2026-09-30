import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for dragging tabs between workspaces — https://github.com/roowus/truss/issues/9
   These FAIL on purpose today: they pin the contract a fix must satisfy.

   Today each workspace is its own Dockview instance (Workspace.tsx:277-291);
   dockview's native drag can't cross instances, and there is NO HTML5
   drag-and-drop anywhere in the app (grep: dataTransfer/draggable/onDrop —
   nothing). Cross-workspace transfer exists only via right-click →
   Copy/Move to <space> (desktops.transferPanel, Workspace.tsx:264-266).

   The contract: a pure src/lib/tabDnd.ts —

   - TAB_DRAG_MIME: a dedicated MIME type ("application/x-truss-tab") so
     foreign drags (files, text, links) are never mistaken for a tab.
   - encodeTabDrag({ from, panelId }) / decodeTabDrag(raw): the payload is
     JSON on the wire; decoding garbage/missing/wrong-shaped data returns
     null, never throws (drop handlers see untrusted dataTransfer contents).
   - isTabDrag(types): dragover gate — only our MIME arms a drop target.
   - resolveTabDrop(payload, targetSpaceId, spaces): decode + decide. A drop
     means MOVE (copy stays on the context menu / a modifier key); dropping
     back onto the source workspace is a no-op (dockview owns intra-instance
     drags); archived or unknown targets reject.

   Component wiring (TrussTab as drag source without breaking dockview's
   native strip drag, DesktopStrip chips lighting up as drop targets, hover
   dwell-to-switch) is covered by the issue's acceptance criteria, not here. */

interface SpaceLike {
  id: string;
  archived?: boolean;
}
type DropDecision =
  | { kind: "move"; from: string; to: string; panelId: string }
  | { kind: "noop" }
  | null;
interface TabDndModule {
  TAB_DRAG_MIME: string;
  encodeTabDrag(payload: { from: string; panelId: string }): string;
  decodeTabDrag(raw: string | null | undefined): { from: string; panelId: string } | null;
  isTabDrag(types: readonly string[]): boolean;
  resolveTabDrop(raw: string | null | undefined, targetSpaceId: string, spaces: SpaceLike[]): DropDecision;
}

async function load(): Promise<TabDndModule | null> {
  const spec = "../src/lib/tabDnd"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

const SPACES: SpaceLike[] = [{ id: "main" }, { id: "desk-2" }, { id: "desk-3", archived: true }];

test("src/lib/tabDnd.ts exists with a dedicated MIME type", async () => {
  const dnd = await load();
  assert.ok(dnd, "src/lib/tabDnd.ts must exist with the drag codec + drop resolution — see issue #9");
  assert.equal(dnd.TAB_DRAG_MIME, "application/x-truss-tab", "our own MIME — foreign drags never arm workspace chips");
});

test("encode/decode round-trips a tab drag payload", async () => {
  const dnd = await load();
  assert.ok(dnd, "tabDnd module must exist (see MIME test)");
  const payload = { from: "main", panelId: "chat:abc123" };
  assert.deepEqual(dnd.decodeTabDrag(dnd.encodeTabDrag(payload)), payload);
  assert.equal(typeof dnd.encodeTabDrag(payload), "string", "dataTransfer carries strings");
});

test("decodeTabDrag: garbage in → null out, never throws", async () => {
  const dnd = await load();
  assert.ok(dnd, "tabDnd module must exist (see MIME test)");
  for (const junk of [null, undefined, "", "not json", "{}", '{"from":1}', '{"from":"a"}', '{"panelId":"p"}', "[]", "null", "42"]) {
    assert.equal(dnd.decodeTabDrag(junk), null, `${JSON.stringify(junk)} → null`);
  }
});

test("isTabDrag arms the drop target only for our payload", async () => {
  const dnd = await load();
  assert.ok(dnd, "tabDnd module must exist (see MIME test)");
  assert.equal(dnd.isTabDrag(["application/x-truss-tab"]), true);
  assert.equal(dnd.isTabDrag(["text/plain", "Files"]), false, "files/text dragged over the strip must not light up chips");
  assert.equal(dnd.isTabDrag([]), false);
});

test("resolveTabDrop: a valid drop onto another live workspace is a MOVE", async () => {
  const dnd = await load();
  assert.ok(dnd, "tabDnd module must exist (see MIME test)");
  const raw = dnd.encodeTabDrag({ from: "main", panelId: "chat:abc123" });
  assert.deepEqual(dnd.resolveTabDrop(raw, "desk-2", SPACES), {
    kind: "move",
    from: "main",
    to: "desk-2",
    panelId: "chat:abc123",
  });
});

test("resolveTabDrop: source workspace, archived targets, unknown targets, and junk all refuse cleanly", async () => {
  const dnd = await load();
  assert.ok(dnd, "tabDnd module must exist (see MIME test)");
  const raw = dnd.encodeTabDrag({ from: "main", panelId: "chat:abc123" });

  assert.deepEqual(dnd.resolveTabDrop(raw, "main", SPACES), { kind: "noop" }, "dropping back on the source is dockview's own drag — no transfer");
  assert.equal(dnd.resolveTabDrop(raw, "desk-3", SPACES), null, "archived workspaces are hidden — nothing may land there");
  assert.equal(dnd.resolveTabDrop(raw, "desk-ghost", SPACES), null, "unknown workspace id");
  assert.equal(dnd.resolveTabDrop("garbage", "desk-2", SPACES), null, "undecodable payload");
  assert.equal(dnd.resolveTabDrop(null, "desk-2", SPACES), null, "no payload at all");
});
