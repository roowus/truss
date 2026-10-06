import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for the unread-message indicator — https://github.com/roowus/truss/issues/173
   ("There's an indicator for online state, but there should ALSO be a
   different-colored one showing there's a new message to read"). These
   FAIL on purpose today: they pin the contract a fix must satisfy.

   Today: sidebar rows show the state dot (STATE_META colors) + the amber
   permission badge + timestamp. Nothing tracks read/unread (grep: the only
   "unread" is feed-item state).

   The contract: src/lib/unread.ts — per-session read markers (client-side;
   the desktops prefs doc, so it survives reloads) —

     isUnread(session: { id, updatedAt, state }, readAt: Record<string, number>, focusedId: string | null): boolean
       — activity AFTER the last read mark = unread; the FOCUSED session is
         never unread (you're looking at it); never for brand-new sessions
         you haven't sent anything into? (no — a fresh session with a reply
         IS unread; a never-touched one with no activity is not);
     markRead(readAt, id, at): Record<string, number>
       — immutable update, capped (the map never grows unbounded);
     sidebarAttention(session, readAt, focusedId): "unread" | null
       — the badge model: unread only when there's something to read;
         permission-waiting is a SEPARATE badge (already exists) and both
         may show. */

interface UnreadModule {
  isUnread(session: { id: string; updatedAt: number; state: string }, readAt: Record<string, number>, focusedId: string | null): boolean;
  markRead(readAt: Record<string, number>, id: string, at: number): Record<string, number>;
  sidebarAttention(session: { id: string; updatedAt: number; state: string }, readAt: Record<string, number>, focusedId: string | null): "unread" | null;
}

async function load(): Promise<UnreadModule | null> {
  const spec = "../src/lib/unread"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

const S = (id: string, updatedAt: number) => ({ id, updatedAt, state: "idle" });

test("src/lib/unread.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/unread.ts must export isUnread/markRead/sidebarAttention — see issue #173");
});

test("the read model: activity after the last read is unread; focusing clears it", async () => {
  const mod = await load();
  assert.ok(mod, "unread module must exist (see module test)");

  let readAt: Record<string, number> = {};
  assert.equal(mod.isUnread(S("a", 1000), readAt, null), false, "never read, no activity → not unread");
  assert.equal(mod.isUnread(S("a", 5000), readAt, null), true, "activity with no read mark → unread");

  readAt = mod.markRead(readAt, "a", 4000);
  assert.equal(mod.isUnread(S("a", 5000), readAt, null), true, "activity after the mark → unread");
  assert.equal(mod.isUnread(S("a", 3000), readAt, null), false, "activity before the mark → read");

  assert.equal(mod.isUnread(S("a", 9000), readAt, "a"), false, "the session you're LOOKING at is never unread");
  assert.equal(mod.isUnread(S("a", 9000), readAt, "b"), true, "…but it is for the one you're not on");

  /* immutability + cap */
  const before = readAt;
  const after = mod.markRead(readAt, "b", 9000);
  assert.notEqual(after, before, "never mutates");
  let big: Record<string, number> = {};
  for (let i = 0; i < 2000; i++) big = mod.markRead(big, `s${i}`, i);
  assert.ok(Object.keys(big).length <= 500, "bounded — the map can't grow forever");
});

test("sidebarAttention: distinct from state and from the permission badge", async () => {
  const mod = await load();
  assert.ok(mod, "unread module must exist (see module test)");

  assert.equal(mod.sidebarAttention(S("a", 5000), {}, null), "unread", "something to read → the badge");
  assert.equal(mod.sidebarAttention(S("a", 5000), { a: 6000 }, null), null, "read → nothing");
  assert.equal(mod.sidebarAttention(S("a", 5000), {}, "a"), null, "focused → nothing");
  /* unread must be computable INDEPENDENT of run state — a running session
     with a settled-but-unseen turn still counts */
  assert.equal(mod.sidebarAttention({ id: "a", updatedAt: 5000, state: "running" }, {}, null), "unread", "running ≠ read");
});

test("read-through: the sidebar row renders the unread badge (distinct from the state dot)", () => {
  const src = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
  assert.ok(
    /sidebarAttention\(|isUnread\(/.test(src),
    "the session row must render the unread indicator — today nothing tracks it (issue #173)",
  );
});
