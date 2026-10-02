import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for visible, self-explaining feed card actions —
   https://github.com/roowus/truss/issues/25
   ("Feed share (and the other 3 buttons) should be more visible — they're so
   small and hidden — and have tooltips so you know what they do").
   These FAIL on purpose today: they pin the contract a fix must satisfy.

   Today the four universal card actions (FeedPanel.tsx:199-204 + CardAction)
   are 24px buttons with 11px icons in the dimmest text color — and icon-only,
   so the only hint at what they do is the slow native title tooltip.

   The contract: a pure src/lib/feedActions.ts describing the row —

     CARD_ACTION_SIZE_PX: number     // the hit target, > today's 24
     CARD_ACTION_ICON_PX: number     // the glyph, > today's 11
     feedCardActions(item) → { id, icon, label, tooltip }[]
       // always the same four, in order: read, save, share, dismiss

   Rules it must honor:
   - the four actions always exist, in that order (no hunting for a moving
     button);
   - EVERY action carries a label AND a tooltip that actually explains the
     action (a sentence naming the outcome — not just the icon's name);
   - labels track state: "Mark read" ⇄ "Mark unread", "Save" ⇄ "Unsave";
     share's tooltip says the card goes to another session;
   - the size constants beat today's 24px target / 11px icon.

   The visual restyle (bigger, brighter, possibly labeled buttons) is the
   acceptance criteria, not pinned here. */

interface FeedItemLike {
  id: string;
  state: string;
}
interface CardActionSpec {
  id: "read" | "save" | "share" | "dismiss";
  icon: string;
  label: string;
  tooltip: string;
}
interface FeedActionsModule {
  CARD_ACTION_SIZE_PX: number;
  CARD_ACTION_ICON_PX: number;
  feedCardActions(item: FeedItemLike): CardActionSpec[];
}

async function load(): Promise<FeedActionsModule | null> {
  const spec = "../src/lib/feedActions"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/feedActions.ts exists; hit targets and glyphs grow past today's 24px/11px", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/feedActions.ts must export feedCardActions + the size constants — see issue #25");
  assert.ok(mod.CARD_ACTION_SIZE_PX >= 28, `hit target ${mod.CARD_ACTION_SIZE_PX}px — today it's 24px, the complaint is reachability`);
  assert.ok(mod.CARD_ACTION_ICON_PX >= 13, `icon ${mod.CARD_ACTION_ICON_PX}px — today it's an 11px smudge`);
});

test("always the same four actions, in the same order — read, save, share, dismiss", async () => {
  const mod = await load();
  assert.ok(mod, "feedActions module must exist (see module test)");
  for (const state of ["unread", "read", "saved"]) {
    const actions = mod.feedCardActions({ id: "f1", state });
    assert.deepEqual(actions.map((a) => a.id), ["read", "save", "share", "dismiss"], `state=${state}: stable set + order`);
    for (const a of actions) assert.ok(a.icon.length > 0, `${a.id}: has an icon`);
  }
});

test("every action has a real tooltip that explains the outcome", async () => {
  const mod = await load();
  assert.ok(mod, "feedActions module must exist (see module test)");
  const actions = mod.feedCardActions({ id: "f1", state: "unread" });
  for (const a of actions) {
    assert.ok(a.label.length > 0, `${a.id}: label present`);
    assert.ok(a.tooltip.length >= 12, `${a.id}: tooltip is a sentence, not a word — got ${JSON.stringify(a.tooltip)}`);
    assert.notEqual(a.tooltip.toLowerCase(), a.icon.toLowerCase(), `${a.id}: tooltip explains more than the icon name`);
  }
  assert.match(actions.find((a) => a.id === "share")!.tooltip, /session|agent|chat/i, "share's tooltip says where the card goes");
});

test("labels track the card's state (read ⇄ unread, save ⇄ unsave)", async () => {
  const mod = await load();
  assert.ok(mod, "feedActions module must exist (see module test)");
  const at = (state: string, id: string) => mod.feedCardActions({ id: "f1", state }).find((a) => a.id === id)!;

  assert.equal(at("unread", "read").label, "Mark read");
  assert.equal(at("read", "read").label, "Mark unread");
  assert.equal(at("read", "save").label, "Save");
  assert.equal(at("saved", "save").label, "Unsave");
  /* and the tooltip flips with it — a stale tooltip is a lie */
  assert.notEqual(at("unread", "read").tooltip, at("read", "read").tooltip);
  assert.notEqual(at("read", "save").tooltip, at("saved", "save").tooltip);
});
