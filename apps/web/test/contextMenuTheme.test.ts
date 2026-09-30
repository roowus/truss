import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* SPEC-TESTS for the transparent tab context menu —
   https://github.com/roowus/truss/issues/32
   ("Right-click a tab → the menu pops up with no background"). These FAIL on
   purpose today: they pin the contract a fix must satisfy.

   Root cause (both halves are one-line evidence):
   - dockview renders `.dv-context-menu` with
     `background: var(--dv-context-menu-background-color,
                    var(--dv-activegroup-hiddenpanel-tab-background-color))`;
   - truss's theme block (index.css, .truss-dock .dockview-theme-dark) sets
     the fallback `--dv-activegroup-hiddenpanel-tab-background-color:
     transparent` (tabs blend into the strip — correct FOR TABS) and never
     defines `--dv-context-menu-background-color`. The menu inherits the
     transparency wholesale — background AND, via
     `--dv-tab-divider-color: transparent`, its border and separators too.

   The contract is stylesheet-level (the failure mode IS textual — a missing
   variable), so these tests read the real index.css:

   1. the truss dockview theme block defines `--dv-context-menu-background-color`
      and `--dv-context-menu-color`, and neither resolves to `transparent`
      (one level of var() indirection resolved);
   2. the menu gets a visible border — either the theme sets a visible
      divider color scoped to the menu, or a `.dv-context-menu` rule sets a
      non-transparent border-color (tabs keep their transparent divider —
      that's intentional and must stay);
   3. the tab vars that must stay transparent (the tab backgrounds + the
      tab divider) are untouched — this is a menu fix, not a tab restyle. */

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/index.css"), "utf8");

function themeVars(): Map<string, string> {
  const m = css.match(/\.truss-dock\s+\.dockview-theme-dark\s*\{([^}]*)\}/);
  assert.ok(m, "the .truss-dock .dockview-theme-dark block must exist");
  const vars = new Map<string, string>();
  for (const v of m![1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars.set(v[1], v[2].trim());
  return vars;
}

function resolveOnce(vars: Map<string, string>, name: string): string | undefined {
  const raw = vars.get(name);
  if (raw === undefined) return undefined;
  const inner = raw.match(/^var\(--([\w-]+)\)$/);
  return inner ? vars.get(inner[1]) ?? raw : raw;
}

test("the theme defines a real context-menu background + text color (not inherited transparency)", () => {
  const vars = themeVars();
  const bg = resolveOnce(vars, "dv-context-menu-background-color");
  assert.ok(bg !== undefined, "--dv-context-menu-background-color must be set — today the menu falls back to the transparent tab background (index.css:58)");
  assert.notEqual(bg, "transparent", "the menu surface must be opaque");
  assert.ok(/var\(--t-(bg|line)/.test(bg!) || /^#|^rgb|^oklch|^hsl/i.test(bg!), "an app surface token, not a loose value");

  const fg = resolveOnce(vars, "dv-context-menu-color");
  assert.ok(fg !== undefined && fg !== "transparent", "--dv-context-menu-color must be set and visible");
});

test("the menu gets a visible border + separators (tab divider stays transparent for tabs)", () => {
  const menuRule = css.match(/\.dv-context-menu\s*\{([^}]*)\}/);
  const vars = themeVars();
  const divider = resolveOnce(vars, "dv-tab-divider-color");

  const borderVisible = !!menuRule && /border[^;]*:\s*[^;]*var\(--t-line[^)]*\)|border-color:\s*(?!transparent\b)[^;]+/i.test(menuRule[1]);
  assert.ok(
    borderVisible || (divider !== undefined && divider !== "transparent"),
    "the menu's border comes from --dv-tab-divider-color, which truss sets to transparent — scope a visible border to the menu instead",
  );

  /* separators use the same divider var — same story */
  const sepVisible = borderVisible || (divider !== undefined && divider !== "transparent");
  assert.ok(sepVisible, "menu separators must be visible");
});

test("the transparent TABS are untouched — only the menu changes", () => {
  const vars = themeVars();
  assert.equal(resolveOnce(vars, "dv-activegroup-hiddenpanel-tab-background-color"), "transparent", "hidden tabs still blend into the strip");
  assert.equal(resolveOnce(vars, "dv-inactivegroup-hiddenpanel-tab-background-color"), "transparent", "inactive hidden tabs too");
  assert.equal(resolveOnce(vars, "dv-tab-divider-color"), "transparent", "tab dividers stay invisible — the menu gets its own border");
});
