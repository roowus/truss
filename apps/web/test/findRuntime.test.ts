import { test } from "node:test";
import assert from "node:assert/strict";

/* Pins for findRuntime's DOM-free parts (issue #194; audit round 1, B5):
   the provider registry — the mechanism behind the PR body's "a query never
   leaks across panels" claim — and terminalMatchCount over a stubbed xterm
   buffer. The DOM/xterm machinery itself is browser-covered (the PR's
   smoke), not node-testable.

   store.ts touches `window` at module scope, so the shim must exist BEFORE
   findRuntime (which reaches store through desktops) is imported — hence
   the dynamic imports. Same shim store.test.ts needs. */
(globalThis as any).window ??= {};

const { registerFindProvider, findProviderFor, terminalMatchCount } = await import("../src/lib/findRuntime");
type FindProvider = import("../src/lib/findRuntime").FindProvider;
type Terminal = import("@xterm/xterm").Terminal;

const stubProvider = (tag: string): FindProvider => ({
  setQuery: () => 0,
  step: () => -1,
  clear: () => {},
  /* tags let the assertions tell instances apart */
  ...({ tag } as object),
});

test("registry: keyed by (dock api, panel id) — same panel id in two workspaces never collides", () => {
  const apiA = {};
  const apiB = {};
  const pa = stubProvider("A");
  const pb = stubProvider("B");

  const offA = registerFindProvider(apiA, "chat:s1", pa);
  const offB = registerFindProvider(apiB, "chat:s1", pb);

  assert.equal(findProviderFor(apiA, "chat:s1"), pa, "workspace A's chat resolves to A's provider");
  assert.equal(findProviderFor(apiB, "chat:s1"), pb, "same panel id, other workspace: its own provider");
  assert.equal(findProviderFor(apiA, "terminal:t1"), undefined, "unknown panel id finds nothing");

  /* the disposer removes only its own registration — unmounting A leaves B */
  offA();
  assert.equal(findProviderFor(apiA, "chat:s1"), undefined);
  assert.equal(findProviderFor(apiB, "chat:s1"), pb);
  offB();
  assert.equal(findProviderFor(apiB, "chat:s1"), undefined);
});

test("registry: a re-register replaces, and a stale disposer must not evict the replacement", () => {
  const api = {};
  const first = stubProvider("first");
  const second = stubProvider("second");
  const offFirst = registerFindProvider(api, "feed", first);
  registerFindProvider(api, "feed", second);
  offFirst(); // an out-of-order unmount cleanup from the older mount
  assert.equal(findProviderFor(api, "feed"), second, "the live registration survives the stale disposer");
});

test("registry: missing dockview context registers nothing and reads back nothing", () => {
  const p = stubProvider("orphan");
  const off = registerFindProvider(undefined, "chat:s1", p);
  assert.equal(findProviderFor(undefined, "chat:s1"), undefined);
  assert.equal(findProviderFor({}, undefined), undefined);
  assert.doesNotThrow(() => off());
});

/* a structural stub of the buffer slice terminalMatchCount reads */
const stubTerm = (lines: { text: string; wrapped?: boolean }[]): Terminal =>
  ({
    buffer: {
      active: {
        length: lines.length,
        getLine: (i: number) => {
          const l = lines[i];
          return l === undefined ? undefined : { translateToString: () => l.text, isWrapped: !!l.wrapped };
        },
      },
    },
  }) as unknown as Terminal;

test("terminalMatchCount: literal, case-insensitive, wrap-aware, scrollback included", () => {
  const term = stubTerm([
    { text: "dev@host:~$ echo TODO one" },
    { text: "TODO one" },
    { text: "a very long line that the terminal soft-wrap", },
    { text: "ped mid-token TODO", wrapped: true },
    { text: "todo lowercase counts too" },
  ]);
  /* "TODO" appears on line 0, line 1, the wrap-joined line 2+3, and
     case-folded on line 4 → 4; the buffer scan sees scrollback rows, not
     just the viewport */
  assert.equal(terminalMatchCount(term, "TODO"), 4);
  assert.equal(terminalMatchCount(term, "wrap ped"), 0, "never across the wrap: joined bare, so the mid-token break has no space");
  assert.equal(terminalMatchCount(term, "soft-wrapped"), 1, "a token split by a soft wrap matches whole — the wrap is invisible");
  assert.equal(terminalMatchCount(term, ""), 0, "blank query matches nothing");
  assert.equal(terminalMatchCount(term, "one TODO"), 0, "a hard break is never straddled: the rows join with \\n, which a single-line query can't hold");
  assert.equal(terminalMatchCount(stubTerm([]), "x"), 0, "empty buffer");
});
