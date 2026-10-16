import { test } from "node:test";
import assert from "node:assert/strict";

/* The picker's breadcrumb builder — extracted so the symlinked-root case is
   testable without a DOM (issue #233, audit round 2 finding B1).

   The bug it pins: mkdir answers with the CANONICAL path (join(realParent,
   clean) — round 1's B3 security fix), while browseRoots() reports roots
   under their LEXICAL names. Matching only the lexical roots meant a folder
   created under a symlinked root matched NO root, so the bar rendered
   `private / tmp / foo` and clicking `private` asked the server for
   /private, which confine() refuses — the picker errored on a crumb it had
   drawn itself. */

interface CrumbsModule {
  browseCrumbs(path: string | null, roots: string[], realRoots?: string[]): { label: string; path: string }[];
}

async function load(): Promise<CrumbsModule | null> {
  const spec = "../src/lib/browseCrumbs"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/browseCrumbs.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/browseCrumbs.ts must export browseCrumbs — see issue #233");
});

test("the roots view has no crumbs", async () => {
  const mod = await load();
  assert.ok(mod, "browseCrumbs module must exist (see module test)");
  assert.deepEqual(mod.browseCrumbs(null, ["/home/dev", "/tmp"]), []);
});

test("a plain path under a root climbs through the root; home labels as ~", async () => {
  const mod = await load();
  assert.ok(mod, "browseCrumbs module must exist (see module test)");
  const c = mod.browseCrumbs("/home/dev/code/truss", ["/home/dev", "/tmp"], ["/home/dev", "/tmp"]);
  assert.deepEqual(
    c.map((x) => x.label),
    ["~", "code", "truss"],
    "home is ~, then each segment",
  );
  assert.deepEqual(
    c.map((x) => x.path),
    ["/home/dev", "/home/dev/code", "/home/dev/code/truss"],
    "each crumb carries the path it navigates to",
  );
});

test("a non-home root is labelled by its own path", async () => {
  const mod = await load();
  assert.ok(mod, "browseCrumbs module must exist (see module test)");
  const c = mod.browseCrumbs("/tmp/work", ["/home/dev", "/tmp"], ["/home/dev", "/tmp"]);
  assert.deepEqual(
    c.map((x) => x.label),
    ["/tmp", "work"],
  );
});

/* the B1 regression */
test("a CANONICAL path under a symlinked root still matches its root crumb", async () => {
  const mod = await load();
  assert.ok(mod, "browseCrumbs module must exist (see module test)");
  /* the macOS shape: /tmp is a link to /private/tmp, so mkdir returns the
     canonical /private/tmp/foo while the root list holds the lexical /tmp */
  const c = mod.browseCrumbs("/private/tmp/foo", ["/home/dev", "/tmp"], ["/home/dev", "/private/tmp"]);
  assert.ok(c.length >= 2, "the root crumb is present, not dropped");
  assert.equal(c[0].label, "/tmp", "labelled by the root the user recognises");
  assert.equal(c[0].path, "/private/tmp", "and it navigates to the canonical root the server will accept");
  assert.deepEqual(
    c.map((x) => x.label),
    ["/tmp", "foo"],
    "NOT `private / tmp / foo` — the old broken render",
  );
});

test("a canonical HOME root labels as ~", async () => {
  const mod = await load();
  assert.ok(mod, "browseCrumbs module must exist (see module test)");
  /* home is /root lexically but resolves to /mnt/real/home/u, so a folder
     created there comes back canonical — it must still read as ~ */
  const c = mod.browseCrumbs("/mnt/real/home/u/code", ["/root", "/tmp"], ["/mnt/real/home/u", "/tmp"]);
  assert.equal(c[0].label, "~", "a resolved home still reads as ~");
  assert.equal(c[0].path, "/mnt/real/home/u", "and navigates to the canonical root");
  assert.deepEqual(
    c.map((x) => x.label),
    ["~", "code"],
    "only the segments BELOW the resolved root get crumbs (u is part of the root)",
  );
});

test("the deepest root wins, and only the matched prefix is crumbed", async () => {
  const mod = await load();
  assert.ok(mod, "browseCrumbs module must exist (see module test)");
  /* /tmp is a root and /tmp/proj is a longer one: the deeper match wins */
  const c = mod.browseCrumbs("/tmp/proj/sub", ["/tmp", "/tmp/proj"], ["/tmp", "/tmp/proj"]);
  assert.deepEqual(
    c.map((x) => x.label),
    ["/tmp/proj", "sub"],
    "no duplicate crumb for the shorter root",
  );
  assert.equal(c[0].path, "/tmp/proj");
});

test("a path matching no root falls back to per-segment crumbs", async () => {
  const mod = await load();
  assert.ok(mod, "browseCrumbs module must exist (see module test)");
  const c = mod.browseCrumbs("/elsewhere/dir", ["/home/dev"], ["/home/dev"]);
  assert.deepEqual(
    c.map((x) => x.label),
    ["elsewhere", "dir"],
    "still renders something rather than nothing",
  );
});

test("garbage never throws and never invents crumbs", async () => {
  const mod = await load();
  assert.ok(mod, "browseCrumbs module must exist (see module test)");
  assert.deepEqual(mod.browseCrumbs("", ["/tmp"]), [], "empty path");
  assert.deepEqual(mod.browseCrumbs(null, ["/tmp"]), [], "roots view");
  assert.doesNotThrow(() => mod.browseCrumbs("/tmp/x", undefined as any), "missing roots");
  assert.doesNotThrow(() => mod.browseCrumbs("/tmp/x", ["/tmp"], undefined as any), "missing realRoots");
  assert.doesNotThrow(() => mod.browseCrumbs("/tmp/x", [null as any, "/tmp"], []), "junk in the root list");
  assert.doesNotThrow(() => mod.browseCrumbs("/tmp/x", "/tmp" as any), "a non-array root list");
  /* a junk root must not be treated as a prefix match */
  const c = mod.browseCrumbs("/tmp/x", [null as any, "/tmp"], []);
  assert.deepEqual(
    c.map((x) => x.path),
    ["/tmp", "/tmp/x"],
  );
});
