import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* REGRESSION for issue #232, bug 2 of 2 — the stale catalog is never repaired.

   `sessions.listModels` re-probed ONLY when the catalog was EMPTY:

     if (opts.probe && models.length === 0 && a.probeModels) { ... }

   A non-empty but WRONG catalog was therefore permanent, and dsh made it
   worse than permanent: `dsh.ts` calls `catalog.set(models)` on every spawn,
   so the narrow 27-row report was continuously REWRITTEN, not left as a
   fossil. Production was `models:dsh = 27 rows {fireworks:27}`.

   The fix has to be a property of the shared lazy-catalog machinery, not a
   dsh special case: hermes has the same exposure (it reports 631 rows from
   its own report, never audited against its configured providers), so the
   same rule covers it for free. Hermes' own numbers are verified separately
   and are NOT pinned here.

   The contract these tests pin:
     - a catalog older than the staleness window is re-probed even when
       non-empty (the fix)
     - a FRESH non-empty catalog is still not re-probed (no probe storm)
     - recording a discovery via set() does NOT count as freshness — that is
       the exact trap dsh falls into by calling set() on every spawn
     - the existing "empty catalog probes" behaviour is unchanged */

const DATA_DIR = mkdtempSync(join(tmpdir(), "truss-test-stale-data-"));
process.env.TRUSS_DATA_DIR = DATA_DIR;

const cache: any = await import("../src/adapters/model-catalog-cache.js");
await import("../src/db.js");

after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ provider: "fireworks", model: `m${i}`, label: `M${i}` }));

test("a non-empty but STALE catalog is re-probed (the bug)", async () => {
  const key = `models:stale-test-${Date.now()}`;
  const cat = cache.lazyCatalog(key, async () => [
    { provider: "deepseek", model: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  ]);
  cat.set(rows(27));
  assert.equal(cat.list().length, 27, "a stale non-empty catalog is present");

  /* with the bug this returned false immediately: models.length !== 0 */
  const changed = await cat.probe({ maxAgeMs: 0 });
  assert.equal(changed, true, "a stale non-empty catalog must be re-probed, not kept forever");
  assert.equal(cat.list()[0].model, "deepseek-v4-pro", "the fresh report replaces the stale rows");
});

test("a FRESH non-empty catalog is still not re-probed (no probe storm)", async () => {
  const key = `models:fresh-test-${Date.now()}`;
  let harvests = 0;
  const cat = cache.lazyCatalog(key, async () => {
    harvests += 1;
    return [{ provider: "fireworks", model: "current", label: "Current" }];
  });
  /* a probe gives the catalog a real discovery timestamp... */
  await cat.probe();
  /* ...after which set() must NOT be able to fake freshness either */
  cat.set(rows(5));

  const changed = await cat.probe({ maxAgeMs: 60_000 });
  assert.equal(changed, false, "a just-probed catalog is not re-probed");
  assert.equal(harvests, 1, "the harvest ran exactly once — no probe storm");
});

test("set() alone does not refresh the staleness clock (dsh's spawn trap)", async () => {
  /* dsh records the catalog on EVERY spawn. If set() counted as freshness,
     the clock would reset on every session and the narrow report would again
     be permanent — the precise failure this fix exists to remove. */
  const key = `models:settrap-test-${Date.now()}`;
  const cat = cache.lazyCatalog(key, async () => [{ provider: "deepseek", model: "fresh", label: "Fresh" }]);
  cat.set(rows(27));
  const changed = await cat.probe({ maxAgeMs: 0 });
  assert.equal(changed, true, "set() must not make a catalog look freshly probed");
  assert.equal(cat.list()[0].model, "fresh");
});

test("an empty catalog still probes (issue #101 behaviour is unchanged)", async () => {
  const key = `models:empty-test-${Date.now()}`;
  const cat = cache.lazyCatalog(key, async () => [{ provider: "hermes", model: "glm-4.7", label: "GLM 4.7" }]);
  assert.equal(cat.list().length, 0, "starts empty");
  const changed = await cat.probe();
  assert.equal(changed, true, "an empty catalog still self-fills on first probe");
  assert.equal(cat.list().length, 1);
});

test("the default staleness window exists and is bounded", () => {
  /* a bounded default matters: too small probes on every picker fetch, too
     large leaves the picker stale for a day. Pin that a default exists. */
  assert.equal(typeof cache.CATALOG_MAX_AGE_MS, "number", "the staleness window must be exported for cross-checks");
  assert.ok(cache.CATALOG_MAX_AGE_MS >= 60_000, "at least a minute — otherwise every fetch probes");
  assert.ok(cache.CATALOG_MAX_AGE_MS <= 24 * 60 * 60 * 1000, "at most a day — otherwise staleness wins again");
});

test("an EMPTY harvest does not refresh the clock (audit B2)", async () => {
  /* A harvest returning nothing must not count as a confirmation. The bug set
     discoveredAt BEFORE the empty check, so one empty answer marked the
     unchanged (still stale) catalog as fresh and suppressed re-probes for the
     whole 6h window — re-arming the exact staleness bug this PR fixes.
     wantsProbe() exposes the age predicate the cooldown sits behind, so this
     asserts the contract directly instead of reasoning about timing. */
  const key = `models:emptyharvest-test-${Date.now()}`;
  let calls = 0;
  const cat = cache.lazyCatalog(key, async () => {
    calls += 1;
    return []; // harness reachable but reports nothing parseable
  });
  cat.set(rows(27));

  const first = await cat.probe({ maxAgeMs: 0 });
  assert.equal(first, false, "an empty harvest reports no change");
  assert.equal(calls, 1, "the harvest ran once");
  assert.equal(cat.list().length, 27, "and leaves the existing rows untouched");

  /* THE PIN: after an empty harvest under a 0ms window, the catalog must
     still read as STALE. With the bug, discoveredAt was refreshed, so under a
     long window wantsProbe() would be false and the wrong catalog would be
     locked in for the whole window. */
  assert.equal(
    cat.wantsProbe(cache.CATALOG_MAX_AGE_MS),
    true,
    "an empty harvest must NOT mark the catalog fresh — it would lock the stale rows in for 6h",
  );

  /* contrast: a NON-EMPTY harvest IS a confirmation, so the same catalog
     reads as fresh under a long window */
  const ok = cache.lazyCatalog(`models:confirmed-test-${Date.now()}`, async () => [
    { provider: "deepseek", model: "fresh", label: "Fresh" },
  ]);
  ok.set(rows(27));
  await ok.probe({ maxAgeMs: 0 });
  assert.equal(ok.wantsProbe(60_000), false, "a non-empty harvest does confirm the catalog");
  assert.equal(ok.wantsProbe(0), true, "but it still goes stale once the window lapses");
});
