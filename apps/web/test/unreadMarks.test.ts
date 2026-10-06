import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* Tests for the stateful half of the unread indicator (issue #173, audit
   round 1 / B1): the spec file unread.test.ts pins the pure badge model;
   this file pins everything that touches the persisted prefs doc — the
   wire validation (parseReadAt), the legacy-doc seed (seedReadMarks), the
   focus transitions (marksForFocusChange), and a read-through that the
   saved layout doc actually carries the marks (the issue's "survives
   reloads" criterion). */

// desktops.ts imports store.ts, which touches `window` at module scope —
// same shim as store.test.ts, installed before the dynamic imports.
(globalThis as any).window ??= {};
(globalThis as any).requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).window.setTimeout ??= globalThis.setTimeout.bind(globalThis);
const { parseReadAt } = await import("../src/lib/desktops");
const { seedReadMarks, marksForFocusChange, READ_AT_CAP } = await import("../src/lib/unread");

test("parseReadAt: wire validation keeps only sane entries", () => {
  assert.equal(parseReadAt(undefined), undefined, "no field → undefined (legacy doc → the seed runs)");
  assert.equal(parseReadAt(null), undefined);
  assert.equal(parseReadAt("junk"), undefined, "a scalar is not a marks map");
  assert.equal(parseReadAt([1, 2]), undefined, "an array is not a marks map");
  assert.deepEqual(parseReadAt({}), {}, "an empty map is a REAL map — seeded docs must not re-seed");
  assert.deepEqual(parseReadAt({ a: 1000, b: 2000 }), { a: 1000, b: 2000 });
  assert.deepEqual(
    parseReadAt({ a: 1000, bad: "soon", worse: Number.NaN, worst: Number.POSITIVE_INFINITY }),
    { a: 1000 },
    "junk values drop out instead of poisoning comparisons",
  );
});

test("seedReadMarks: the upgrade baseline marks everything listed at its own activity", () => {
  assert.deepEqual(seedReadMarks([]), {}, "nothing listed → an empty (but real) map");
  const seed = seedReadMarks([
    { id: "a", updatedAt: 1000 },
    { id: "b", updatedAt: 9000 },
  ]);
  assert.deepEqual(seed, { a: 1000, b: 9000 }, "each session reads as seen up to its own last activity");
  assert.equal(seed.b, 9000, "a session with history seeds read — no upgrade dot storm");
});

test("marksForFocusChange: opening marks the session, leaving marks it too", () => {
  assert.equal(marksForFocusChange({ a: 1 }, "a", "a", 5000), null, "no focus change → no write");

  const opened = marksForFocusChange({}, undefined, "a", 5000);
  assert.deepEqual(opened, { a: 5000 }, "focusing a session marks it read");

  const moved = marksForFocusChange({ a: 1000 }, "a", "b", 5000);
  assert.deepEqual(moved, { a: 5000, b: 5000 }, "the session being left counts as seen up to the switch");

  const blurred = marksForFocusChange({ a: 1000 }, "a", undefined, 5000);
  assert.deepEqual(blurred, { a: 5000 }, "focus leaving for a non-session panel still marks the session");

  const before = { a: 1000 };
  marksForFocusChange(before, "a", "b", 5000);
  assert.deepEqual(before, { a: 1000 }, "never mutates the input map");
});

test("marksForFocusChange stays inside the cap across a focus storm", () => {
  let readAt: Record<string, number> = {};
  let prev: string | undefined;
  for (let i = 0; i < 2000; i++) {
    const id = `s${i}`;
    readAt = marksForFocusChange(readAt, prev, id, i) ?? readAt;
    prev = id;
  }
  assert.ok(Object.keys(readAt).length <= READ_AT_CAP, "the persisted map is bounded no matter how focus moves");
});

test("read-through: the row's unread treatment is the violet attention bar, not a second dot", () => {
  /* PR #182 review feedback: two dots side by side read as noise — the
     unread signal shares the focused bar's left-edge slot (the focused
     session is never unread, so they never collide) and the state dot
     keeps the right edge alone */
  const src = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
  assert.ok(/attention === "unread"/.test(src), "SessionRow renders the sidebarAttention model (issue #173)");
  assert.ok(/bg-\[var\(--t-violet\)\]/.test(src), "the unread treatment is violet — never the state dot's teal/amber/red or the permission pill's amber");
});

test("read-through: the saved layout doc carries the read marks (survives reloads)", () => {
  const src = readFileSync(new URL("../src/lib/desktops.ts", import.meta.url), "utf8");
  assert.ok(
    /readAt: this\.state\.readAt/.test(src),
    "the snapshot must write readAt into the saved doc — drop it and the badges forget everything on reload (issue #173)",
  );
  assert.ok(
    /readAt: parseReadAt\(doc\.readAt\)/.test(src),
    "parseSaved must read the marks back — drop it and the badges forget everything on reload (issue #173)",
  );
});
