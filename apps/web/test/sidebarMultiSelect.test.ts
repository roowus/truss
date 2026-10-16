import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* Read-through wiring tests for issue #225's sidebar multi-select.

   The pure model is pinned by test/multiSelect.test.ts (the issue's
   spec-test) and test/multiSelectModel.test.ts. These pin the OTHER half —
   the Sidebar wiring — which is what audit round 1 (B1/B2) found untested:
   the bulk bar's appear rule and action dispatch, the prune effect, Esc
   clearing, and the click routing.

   The most important one is the plain-click collapse: round 1's B1 was a
   real regression where every unmodified click short-circuited to
   openSession/openPanel and never touched the selection, so a stale
   multi-selection survived clicking an unrelated row (for shells/hosts
   that meant acting destructively on the wrong set). A source-level pin is
   the established convention here — see sidebarRename.test.ts,
   rowCluster.test.ts, unreadMarks.test.ts. */

const SIDEBAR = new URL("../src/components/Sidebar.tsx", import.meta.url);
const src = readFileSync(SIDEBAR, "utf8");

/* the three row bodies, so the assertions below can be scoped to each */
function rowBlock(startMarker: string, endMarker: string): string {
  const from = src.indexOf(startMarker);
  assert.ok(from >= 0, `Sidebar.tsx lost ${startMarker}`);
  const to = src.indexOf(endMarker, from);
  assert.ok(to > from, `Sidebar.tsx lost the marker after ${startMarker}`);
  return src.slice(from, to);
}

test("the sidebar drives the SHARED selection model (one model, no fork — #226 dependency)", () => {
  assert.ok(
    /from "@\/lib\/multiSelect"/.test(src),
    "the sidebar imports the shared model, never a private copy",
  );
  assert.ok(/applyClick/.test(src), "clicks go through applyClick");
  assert.ok(/pruneSelection/.test(src), "the prune effect uses the model's prune");
  assert.ok(/bulkActions/.test(src), "the bulk bar's actions come from the model");
  assert.ok(/createSelection/.test(src), "createSelection seeds and clears the state");
  /* the one stateful bit — a React useState, because the model itself is pure */
  assert.ok(
    /useState<SelectionState>/.test(src),
    "the sidebar holds exactly one SelectionState (the model stays React-free)",
  );
});

test("plain click COLLAPSES to one row — the B1 regression (every row routes through the model)", () => {
  /* the bug: the unmodified branch returned after openSession/openPanel and
     never called the model, so the collapse path was unreachable */
  const navOnly = /onClick=\{\(e\) => \{\s*if \(e\.shiftKey \|\| e\.metaKey \|\| e\.ctrlKey\) \{\s*onRowClick\([^)]*\);\s*return;\s*\}\s*(openSession|openPanel|open)\(/;
  assert.ok(
    !navOnly.test(src),
    "a row must never short-circuit a plain click away from the selection model — that was audit round 1's B1",
  );

  for (const [name, start, end] of [
    ["SessionRow", "function SessionRow(", "function ShellRow("],
    ["ShellRow", "function ShellRow(", "function PairRequestRow("],
    ["HostRow", "function HostRow(", "function GroupTrash("],
  ] as const) {
    const body = rowBlock(start, end);
    assert.ok(body.length > 0, `${name} found`);
    /* every click goes through onRowClick first… */
    assert.ok(
      /onClick=\{\(e\) => \{\s*onRowClick\(/.test(body),
      `${name}: the click handler must call onRowClick unconditionally`,
    );
    /* …and the navigate/open is GUARDED by "no modifier", so a modified click
       builds the selection instead of navigating */
    assert.ok(
      /if \(!e\.shiftKey && !e\.metaKey && !e\.ctrlKey\)/.test(body),
      `${name}: opening must be guarded so shift/cmd/ctrl never navigate`,
    );
    assert.ok(
      /selected/.test(body),
      `${name}: renders its selection state`,
    );
  }
});

test("the bulk bar appears only with a selection, and its actions are the model's", () => {
  assert.ok(
    /selectionCount > 0 && \(\s*<BulkBar/.test(src),
    "the bar renders only while something is selected (≥1 row)",
  );
  assert.ok(/count=\{selectionCount\}/.test(src), "the bar is told the count");
  assert.ok(/actions=\{actions\}/.test(src), "the bar renders the model's action set, not its own list");
  /* the action set is computed by the pure model over a kind map */
  assert.ok(
    /bulkActions\(sel, sidebarItems\(sessions, terminals, hosts\)\)/.test(src),
    "actions come from bulkActions(sel, items) — the model owns the rules",
  );
  /* the kind map the model needs: all three kinds, so a mixed set is real */
  assert.ok(/kind: "session"/.test(src), "sessions are mapped to their kind");
  assert.ok(/kind: "shell"/.test(src), "shells are mapped to their kind");
  assert.ok(/kind: "host"/.test(src), "hosts are mapped to their kind");
});

test("bulk dispatch is per-kind and keeps the two-click gate (never a lighter confirm)", () => {
  /* BulkBar is the last function in the file — slice to EOF */
  const bar = src.slice(src.indexOf("function BulkBar("));
  assert.ok(bar.startsWith("function BulkBar("), "BulkBar found");

  /* the destructive action keeps the armed confirm */
  assert.ok(/action\.confirm/.test(bar), "the bar honours the model's confirm flag");
  assert.ok(/setConfirm\(true\)/.test(bar), "first click arms");
  assert.ok(/Click again:/.test(bar), "the armed state says so in words");
  assert.ok(
    /setTimeout\(\(\) => setConfirm\(false\), 3000\)/.test(bar),
    "the arm auto-disarms after 3s like every other confirm in this file",
  );

  /* each kind takes its own correct store call — an archived session is not
     killed, a shell is not trashed */
  assert.ok(/store\.bulkDeleteSessions\(sessionIds\)/.test(bar), "sessions → bulk trash");
  assert.ok(/desktops\.killTerminal\(id\)/.test(bar), "shells → kill");
  assert.ok(/store\.deleteHost\(id\)/.test(bar), "hosts → delete");
  assert.ok(/store\.archiveSession\(id, true\)/.test(bar), "archive → archiveSession");
  assert.ok(/store\.pinSession\(id, true\)/.test(bar), "pin routes per kind too");
  assert.ok(/store\.pinTerminal\(id, true\)/.test(bar), "…shell");
  assert.ok(/store\.pinHost\(id, true\)/.test(bar), "…host");

  /* a disabled action says why and does nothing */
  assert.ok(/if \(action\.disabled\) return;/.test(bar), "a reason-disabled action is inert");
  assert.ok(/disabled=\{\!\!a\.disabled\}/.test(bar), "…and renders disabled");
  assert.ok(
    /const title = a\.disabled \?\?/.test(bar) && /title=\{title\}/.test(bar),
    "…with the reason as its tooltip (the disabled reason wins over any confirm hint)",
  );
});

test("Esc clears the selection but not while the user is typing", () => {
  const esc = rowBlock("const onKey = (e: KeyboardEvent)", "document.addEventListener");
  assert.ok(/e\.key !== "Escape"/.test(esc), "Esc is the key");
  assert.ok(/setSel\(createSelection\(\)\)/.test(esc), "Esc clears through the model's factory");
  assert.ok(
    /tagName === "INPUT" \|\| t\.tagName === "TEXTAREA" \|\| t\.isContentEditable/.test(esc),
    "Esc in the search box (or a rename field) must not be hijacked",
  );
  assert.ok(/removeEventListener\("keydown", onKey\)/.test(src), "the listener is cleaned up");
});

test("vanished rows prune out of the selection on every visible-order change", () => {
  assert.ok(
    /const visibleIds = useMemo/.test(src),
    "the visible order is one memo — the array shift ranges are measured against",
  );
  /* the prune effect: runs off visibleIds, uses the model, and bails out when
     nothing changed (no render loop) */
  const prune = rowBlock("setSel((s) => {", "}, [visibleIds]);");
  assert.ok(/pruneSelection\(s, visibleIds\)/.test(prune), "the prune effect uses pruneSelection over the visible ids");
  assert.ok(
    /next\.ids\.size === s\.ids\.size && next\.anchor === s\.anchor \? s : next/.test(prune),
    "unchanged state keeps its identity — otherwise the effect would re-render forever",
  );

  /* the visible order really is the RENDERED order: collapsed groups are
     skipped and both the plain and archived lists contribute */
  const vis = rowBlock("const visibleIds = useMemo", "}, [groups, archived, collapsed, terminals, hosts]);");
  assert.ok(/if \(collapsed\[key\]\) continue;/.test(vis), "a collapsed group's rows are not in the visible order");
  assert.ok(/for \(const s of archived\)/.test(vis), "the expanded archived list contributes");
  assert.ok(/for \(const t of sortWithPinned\(terminals/.test(vis), "shells contribute");
  assert.ok(/for \(const h of sortWithPinned\(hosts/.test(vis), "hosts contribute");
});

test("the row click passes the real modifier keys into the model", () => {
  assert.ok(
    /applyClick\(s, id, \{ shift: e\.shiftKey, meta: e\.metaKey, ctrl: e\.ctrlKey \}, visibleIds\)/.test(src),
    "onRowClick forwards shift/meta/ctrl AND the visible order — the two things the model needs",
  );
});

test("selection is announced to assistive tech (round-1 B3: aria-pressed, not aria-selected)", () => {
  /* aria-selected is only honoured on option/row/tab/treeitem/gridcell; these
     rows are role=button divs, so it was silently ignored */
  assert.ok(!/aria-selected=/.test(src), "no aria-selected on button-role rows (round-1 B3)");
  assert.ok(/aria-pressed=\{selected \|\| undefined\}/.test(src), "selection rides aria-pressed instead");
});

test("the bulk destructive tooltip names the per-kind consequence (round-1 B4)", () => {
  assert.ok(/CONFIRM_HINT/.test(src), "the armed bulk tooltips come from a hint map");
  assert.ok(
    /hosts are deleted \(drops their agent\)/.test(src),
    "the bulk delete repeats the single-row warning — it is the MORE destructive path, never vaguer",
  );
  assert.ok(!/Click again to confirm"\s*:/.test(src), "the generic 'Click again to confirm' is gone");
});
