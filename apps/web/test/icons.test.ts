import { test } from "node:test";
import assert from "node:assert/strict";
import { ICON_PATHS } from "../src/lib/icons";

/* Regression pin for the icon registry (issue #99, PR #102 audit round 1 /
   B2): the extraction from ui.tsx converted every glyph from JSX elements
   (rects, circles, multi-element fragments) to path-data strings — a single
   wrong number in any of the ~34 converted glyphs would otherwise ship
   green. Structural checks only: completeness, well-formedness, arc flags,
   sane coordinates; geometry itself was verified pixel-identical against
   the old JSX in headless Chromium during the PR. */

const COMMANDS = new Set(["M", "m", "L", "l", "H", "h", "V", "v", "C", "c", "S", "s", "Q", "q", "T", "t", "A", "a", "Z", "z"]);

/* tokenize path data into [command, ...numbers] groups */
function segments(d: string): { cmd: string; nums: number[] }[] {
  const out: { cmd: string; nums: number[] }[] = [];
  const re = /([A-Za-z])|(-?(?:\d*\.\d+|\d+))/g;
  let m: RegExpExecArray | null;
  let cur: { cmd: string; nums: number[] } | null = null;
  while ((m = re.exec(d))) {
    if (m[1] !== undefined) {
      assert.ok(COMMANDS.has(m[1]), `unknown path command "${m[1]}"`);
      cur = { cmd: m[1], nums: [] };
      out.push(cur);
    } else {
      assert.ok(cur, `number "${m[2]}" before any command`);
      cur.nums.push(parseFloat(m[2]));
    }
  }
  return out;
}

test("the registry is complete — every glyph survived the extraction", () => {
  assert.equal(Object.keys(ICON_PATHS).length, 39, "37 glyphs extracted from ui.tsx + pinSolid (#99) + clock (#16)");
});

test("every glyph is well-formed path data on the 16px grid", () => {
  for (const [name, def] of Object.entries(ICON_PATHS)) {
    assert.ok(def.path.length > 0, `${name}: empty path`);
    assert.match(def.path, /^[Mm]/, `${name}: path data starts with a moveto`);
    for (const seg of segments(def.path)) {
      for (const n of seg.nums) {
        assert.ok(Number.isFinite(n) && Math.abs(n) <= 20, `${name}: coordinate ${n} off the 16px grid`);
      }
      /* arcs carry rx ry rotation large-arc sweep x y — both flags are 0|1 */
      if (seg.cmd === "A" || seg.cmd === "a") {
        assert.equal(seg.nums.length % 7, 0, `${name}: arc takes groups of 7 params`);
        for (let i = 0; i + 4 < seg.nums.length; i += 7) {
          assert.ok(seg.nums[i + 3] === 0 || seg.nums[i + 3] === 1, `${name}: bad large-arc flag ${seg.nums[i + 3]}`);
          assert.ok(seg.nums[i + 4] === 0 || seg.nums[i + 4] === 1, `${name}: bad sweep flag ${seg.nums[i + 4]}`);
        }
      }
    }
  }
});

test("the fill/stroke split is honest — only the filled glyphs fill", () => {
  const filled = Object.keys(ICON_PATHS).filter((n) => ICON_PATHS[n].fill);
  assert.deepEqual(filled.sort(), ["dots", "pinSolid"], "everything else strokes (1.5px, fill=none)");
});
