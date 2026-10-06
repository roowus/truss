import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for the tab context menu's surface — https://github.com/roowus/truss/issues/172
   ("Right-click a tab: the popup menu's background is basically transparent
   — hard to read"). These FAIL on purpose today: they pin the contract a
   fix must satisfy.

   Root cause (traced through dockview's css): dockview renders
   `.dv-context-menu` with
     background: var(--dv-context-menu-background-color,
                 var(--dv-activegroup-hiddenpanel-tab-background-color));
   and truss's theme sets that fallback var to `transparent` (deliberately —
   hidden tabs are invisible in the strip, index.css:58). With no direct
   context-menu var set, the menu inherits the tab transparency. The menu
   was never themed — it just fell through the fallback chain into
   see-through.

   The contract (CSS read-through on index.css):
   - `--dv-context-menu-background-color` is set to an OPAQUE surface token
     (var(--t-bg2) or equivalent) — NOT "transparent", NOT unset;
   - the menu gets readable chrome (border + shadow) via a
     .dv-context-menu rule;
   - the tab-strip var stays transparent (tabs are correct as-is — the fix
     must not make hidden tabs opaque). */

const CSS = () => readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

test("the context menu gets its own opaque background var", () => {
  const css = CSS();
  const m = css.match(/--dv-context-menu-background-color:\s*([^;]+);/);
  assert.ok(m, "index.css must set --dv-context-menu-background-color — today the menu falls back to the transparent hidden-tab var (dockview.css:4064) and renders see-through (issue #172)");
  assert.ok(!/transparent/.test(m![1]), "opaque, not transparent");
  assert.match(m![1], /--t-bg[02]/, "a real surface token");
});

test("the menu carries readable chrome (border + shadow, themed)", () => {
  const css = CSS();
  const rule = css.match(/\.dv-context-menu\s*\{[^}]*\}/s);
  assert.ok(rule, "a .dv-context-menu rule must exist with its chrome");
  assert.ok(/border/.test(rule![0]), "a border separates it from what's beneath");
  assert.ok(/box-shadow/.test(rule![0]), "and a shadow lifts it");
});

test("guard: hidden tabs STAY transparent — the fix is the menu's own var", () => {
  const css = CSS();
  assert.ok(
    /--dv-activegroup-hiddenpanel-tab-background-color:\s*transparent/.test(css),
    "the hidden-tab transparency is correct for the strip — don't fix the menu by making tabs opaque",
  );
});

/* audit round-2 pins: the contract tests above check only that chrome
   EXISTS — the two declarations later rounds settled on could silently
   revert green (a weaker literal shadow, a deleted separator rule both
   pass "box-shadow is present"). Pin WHICH shadow and the separator's
   visible line. */
test("the chrome uses the SHARED floating shadow token, not a bespoke one", () => {
  const css = CSS();
  const rule = css.match(/\.dv-context-menu\s*\{[^}]*\}/s);
  assert.ok(rule, "the chrome rule must exist");
  assert.match(
    rule![0],
    /box-shadow:\s*var\(--dv-floating-box-shadow\)/,
    "the menu's shadow is dockview's themed floating token — a weaker one-off downgrades the existing lift",
  );
});

test("menu separators get a visible line on the opaque surface", () => {
  const css = CSS();
  const sep = css.match(/\.dv-context-menu-separator\s*\{[^}]*\}/);
  assert.ok(sep, "a .dv-context-menu-separator rule must exist — separators read the transparent tab-divider var otherwise");
  assert.match(sep![0], /background:\s*var\(--t-line[0-9]?\)/, "a real line token, visible on --t-bg2");
});
