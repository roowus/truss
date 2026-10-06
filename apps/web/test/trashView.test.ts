import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for a real Trash surface — https://github.com/roowus/truss/issues/146
   ("I asked for the 30-day deleted-chat recovery before… if it was added I
   can't find where to access it — make a tab where you can recover deleted
   stuff. Also a place to browse and recover deleted workspaces / tab panel
   groups"). These FAIL on purpose today: they pin the contract a fix must
   satisfy.

   What's there (investigated):
   - The 30-day chat trash EXISTS server-side (deleted_at + restore + purge
     + purgeExpiredTrash) and renders as a collapsed "recently deleted"
     sidebar section — HIDDEN WHEN EMPTY (Sidebar.tsx:476 —
     `if (trash.length === 0) return null`), which is exactly why the user
     can't find it.
   - Closed workspaces/tab-groups ride an IN-MEMORY undo stack
     (desktops.ts closedStack, #115) — gone on reload, not browsable.

   The contract:

   1. src/lib/trashView.ts — one unified listing:

        trashEntries({ sessions, closed, now }): TrashEntry[]
          TrashEntry = { kind: "session" | "workspace" | "tab-group" | "tab";
                         id; title; deletedAt; daysLeft?: number; restoreId }

      sessions (deleted_at set) + closed workspaces/tab-groups/tabs, sorted
      most-recent first; sessions carry daysLeft (30-day window math);
      unknown/garbage rows never crash the list.

   2. the closed stack PERSISTS — serializeClosed/parseClosed in
      workspaceClose.ts (validated, capped, garbage → []), and the desktops
      save doc carries it (read-through pin on desktops.ts: the saved layout
      includes the closed stack).

   3. an ALWAYS-PRESENT entry point (read-through): a Trash affordance that
      renders even when empty (the picker/registry lists a "trash" panel
      kind). */

interface TrashViewModule {
  trashEntries(input: {
    sessions: { id: string; title: string; deleted_at?: number | null }[];
    closed: { type: string; name?: string; at: number; panels?: { id?: string; title?: string }[] }[];
    now: number;
  }): { kind: string; id: string; title: string; deletedAt: number; daysLeft?: number; restoreId: string }[];
}

async function load(): Promise<TrashViewModule | null> {
  const spec = "../src/lib/trashView"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

const NOW = Date.now();
const DAY = 86_400_000;

test("src/lib/trashView.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/trashView.ts must export trashEntries — see issue #146");
});

test("one listing: sessions with days-left + closed workspaces/groups, newest first", async () => {
  const mod = await load();
  assert.ok(mod, "trashView module must exist (see module test)");

  const entries = mod.trashEntries({
    sessions: [
      { id: "s1", title: "old chat", deleted_at: NOW - 29 * DAY },
      { id: "s2", title: "fresh chat", deleted_at: NOW - DAY },
      { id: "s3", title: "live chat", deleted_at: null },
    ],
    closed: [
      { type: "workspace", name: "research", at: NOW - 3600_000 },
      { type: "tab-group", name: "2 tabs", at: NOW - 1800_000 },
    ],
    now: NOW,
  });

  assert.equal(entries.length, 4, "live sessions never list; the rest do");
  assert.equal(entries[0].kind, "tab-group", "most recent first");
  assert.equal(entries[0].title, "2 tabs");
  const oldChat = entries.find((e) => e.id === "s1")!;
  assert.equal(oldChat.kind, "session");
  assert.ok(oldChat.daysLeft !== undefined && oldChat.daysLeft <= 1, "29 days in → ~1 day left (the retention math)");
  const freshChat = entries.find((e) => e.id === "s2")!;
  assert.ok(freshChat.daysLeft! >= 28, "1 day in → ~29 left");
  assert.ok(entries.every((e) => e.restoreId), "every entry can be restored");
});

test("the runtime close shape (type \"panels\") maps to tab/tab-group; unknown rows drop", async () => {
  const mod = await load();
  assert.ok(mod, "trashView module must exist (see module test)");

  /* what the live app actually pushes (panelsEntry in workspaceClose.ts):
     one panel is a tab close, several a group close — the friendly
     tab/tab-group forms above are the persisted/legacy spellings */
  const entries = mod.trashEntries({
    sessions: [],
    closed: [
      { type: "panels", at: NOW - 1000, panels: [{ id: "chat:a", title: "chat a" }] },
      { type: "panels", at: NOW - 2000, panels: [{ id: "chat:b", title: "chat b" }, { id: "git:b", title: "git b" }] },
      { type: "panels", at: NOW - 3000, panels: [{ id: "chat:c" }] },
      { type: "mystery", name: "from a future build", at: NOW - 500 },
    ],
    now: NOW,
  });

  assert.equal(entries.length, 3, "unknown types drop out, the rest list");
  const lone = entries.find((e) => e.title === "chat a")!;
  assert.equal(lone.kind, "tab", "one panel is a tab close");
  const group = entries.find((e) => e.kind === "tab-group")!;
  assert.equal(group.title, "2 tabs", "several panels read as a count");
  const untitled = entries.find((e) => e.deletedAt === NOW - 3000)!;
  assert.equal(untitled.title, "chat:c", "a panel without a title falls back to its id");
  assert.ok(entries.every((e) => e.restoreId), "every listed row restores");
});

test("the closed stack persists: serialize/parse round-trip, validated, capped, garbage-proof", async () => {
  const wc: any = await import("../src/lib/workspaceClose.js");
  assert.equal(typeof wc.serializeClosed, "function", "workspaceClose.ts must export serializeClosed — see issue #146");
  assert.equal(typeof wc.parseClosed, "function", "and parseClosed");

  const stack = [
    { type: "workspace", name: "research", layout: { panels: ["chat:a"] }, at: 1 },
    { type: "tab", name: "chat x", at: 2 },
  ];
  const round = wc.parseClosed(wc.serializeClosed(stack));
  assert.deepEqual(round, stack, "a reload brings the trash back");

  assert.deepEqual(wc.parseClosed("not json"), [], "garbage → empty, never a crash");
  assert.deepEqual(wc.parseClosed('{"nope":true}'), [], "wrong shape → empty");
  assert.deepEqual(wc.parseClosed(wc.serializeClosed(null)), [], "null stack → empty");

  const big = Array.from({ length: 50 }, (_, i) => ({ type: "tab", name: `t${i}`, at: i }));
  assert.ok(wc.parseClosed(wc.serializeClosed(big)).length <= 10, "the persisted stack is capped");
});

test("rows parseClosed admits but this build cannot restore never crash the palette (audit round 2)", async () => {
  const wc: any = await import("../src/lib/workspaceClose.js");
  assert.equal(typeof wc.canRestore, "function", "workspaceClose.ts must export canRestore — the shared restorability guard");

  /* the friendly forms the round-trip above pins, and a panels row with no
     panels, are listable but not restorable */
  assert.equal(wc.canRestore({ type: "tab", name: "chat x", at: 2 }), false);
  assert.equal(wc.canRestore({ type: "tab-group", name: "2 tabs", at: 2 }), false);
  assert.equal(wc.canRestore({ type: "panels", spaceId: "s", panels: [], at: 3 }), false);
  assert.equal(wc.canRestore({ type: "workspace", name: "w", layout: null, at: 1 }), true);
  assert.equal(wc.canRestore({ type: "panels", spaceId: "s", panels: [{ id: "chat:a" }], at: 4 }), true);

  /* Chrome.tsx renders describeClosed(peekClosed()) with no error boundary:
     an unrestorable top-of-stack must label, never throw */
  assert.doesNotThrow(() => wc.describeClosed({ type: "tab", name: "chat x", at: 2 }));
  assert.doesNotThrow(() => wc.describeClosed({ type: "panels", spaceId: "s", panels: [], at: 3 }));
  assert.equal(wc.describeClosed({ type: "workspace", name: "research", layout: null, at: 1 }), "Reopen closed workspace: research");
});

test("read-through: the save doc carries the closed stack + a Trash entry point always renders", () => {
  const desktops = readFileSync(new URL("../src/lib/desktops.ts", import.meta.url), "utf8");
  assert.ok(
    /closed: serializeClosed/.test(desktops) && /queueSave/.test(desktops),
    "desktops.ts must persist the closed stack with the layout doc — today it's in-memory only, gone on reload (issue #146)",
  );
  const picker = readFileSync(new URL("../src/components/TabPicker.tsx", import.meta.url), "utf8");
  assert.ok(/openPanel\("trash"/.test(picker), "the tab picker must list a Trash panel — the recover surface is discoverable even when empty");
});
