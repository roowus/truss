import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer, type TestServer } from "./server-harness.js";
import { freshServer } from "./helpers.js";

/* The mkdir route writes to disk, so the NEGATIVE cases are the valuable
   ones (issue #233; the developer's constraint on the design Q&A).

   The issue's spec test (dirbrowse-mkdir.test.ts) covers one outside-roots
   parent and one traversal name. This file is the security boundary around
   them: a symlink inside a root pointing OUTSIDE it, `~` expansion, a
   parent that is itself outside the roots, and the full name matrix. Every
   assertion here is "nothing was created", not merely "some status came
   back" — a route that answers 403 after writing is still an escape. */

interface MkdirModule {
  validDirName(name: string): string | null;
}

async function load(): Promise<MkdirModule | null> {
  const { cleanup } = await freshServer("mkdir-confine-mod");
  try {
    const spec = "../src/dirbrowse.js";
    const mod: any = await import(spec);
    return typeof mod?.validDirName === "function" ? mod : null;
  } finally {
    cleanup();
  }
}

/* ── the name matrix: garbage never reaches the filesystem ── */

test("validDirName: trims, allows what a folder may hold, refuses the rest", async () => {
  const mod = await load();
  assert.ok(mod, "dirbrowse.ts must export validDirName — see issue #233");

  assert.equal(mod.validDirName("project"), "project");
  assert.equal(mod.validDirName("  padded  "), "padded", "outer whitespace is trimmed away");
  assert.equal(mod.validDirName(".hidden"), ".hidden", "dotfolders are legal (the .* toggle decides whether they list)");
  assert.equal(mod.validDirName("ünïcode-é"), "ünïcode-é", "non-ASCII names are people's real folder names");
  assert.equal(mod.validDirName("x".repeat(64)), "x".repeat(64), "64 is the cap, inclusive");

  for (const bad of [".", "..", "", "   ", "x".repeat(65), "a/b", "a\\b", "/abs", "../x", "x/", "\\x", "nul\u0000byte", "bell\u0007", "del\u007f", "nl\nname", "tab\tname"]) {
    assert.equal(mod.validDirName(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
});

test("validDirName: non-strings never throw, never pass", async () => {
  const mod = await load();
  assert.ok(mod, "dirbrowse.ts must export validDirName — see issue #233");
  for (const bad of [undefined, null, 42, {}, [], true] as any[]) {
    assert.equal(mod.validDirName(bad), null, `refused: ${String(bad)}`);
  }
});

/* ── the live route, checked against the disk ── */

let srv: TestServer;
before(async () => {
  srv = await bootServer("mkdir-confine-live");
});
after(async () => {
  await srv.close();
});

const mkdir = (body: unknown) =>
  fetch(`${srv.base}/api/browse/mkdir`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/* The real "outside" is anything that is not /tmp and not $HOME — /var/tmp
   is both writable and NOT a browse root, so it proves the boundary the
   /tmp fixture cannot (an "outside" dir under /tmp would itself be inside
   the /tmp root and wrongly pass). */
const OUTSIDE = "/var/tmp/truss-mkdir-outside-escape";

/* a fixture under a browsable root (/tmp is one): a real dir, and a link
   inside the root that points at the OUTSIDE target */
let WS: string;
before(() => {
  WS = mkdtempSync(join(tmpdir(), "truss-mkdir-conf-"));
  mkdirSync(join(WS, "real"));
  mkdirSync(OUTSIDE, { recursive: true });
  symlinkSync(OUTSIDE, join(WS, "escape-link"));
});
after(() => {
  for (const d of [WS, OUTSIDE]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

test("confinement: parents outside the roots never create anything anywhere", async () => {
  for (const parent of ["/etc", "/", join(WS, "..", ".."), "/nonexistent-deep-dir", OUTSIDE]) {
    const res = await mkdir({ parent, name: "truss-mkdir-should-not-exist" });
    assert.ok([400, 403].includes(res.status), `${parent} → refused (got ${res.status})`);
    assert.ok(!existsSync(join(parent, "truss-mkdir-should-not-exist")), `${parent} got nothing written`);
  }
  assert.ok(!existsSync("/truss-mkdir-should-not-exist"), "never at the filesystem root");
  assert.ok(!existsSync(join(OUTSIDE, "truss-mkdir-should-not-exist")), "never in an outside dir");
});

test("confinement: an escape is 403 (a permission answer), bad input is 400", async () => {
  /* Regression: confine() is shared with listDirs and throws plain Errors,
     so an untranslated route answered 400 for EVERY refusal and the
     documented 403 never happened. The spec test accepts [400, 403] and so
     never caught it — this pins the distinction itself. */
  assert.equal((await mkdir({ parent: "/etc", name: "nope" })).status, 403, "outside the roots is a permissions answer, not malformed input");
  assert.equal((await mkdir({ parent: join(WS, "does-not-exist"), name: "nope" })).status, 400, "a missing parent is bad input");
  assert.equal((await mkdir({ parent: WS, name: "a/b" })).status, 400, "a malformed name is bad input, never 403");
});

test("confinement: a symlink out of the roots is not a way through", async () => {
  const res = await mkdir({ parent: join(WS, "escape-link"), name: "through-the-link" });
  assert.ok([400, 403].includes(res.status), `a link escaping the roots → refused (got ${res.status})`);
  assert.ok(!existsSync(join(OUTSIDE, "through-the-link")), "and NOTHING was created on the far side — this is the whole point");
});

test("confinement: a dangling symlink at the target name is refused, never written through", async () => {
  symlinkSync(join(OUTSIDE, "not-there-yet"), join(WS, "dangling"));
  const res = await mkdir({ parent: WS, name: "dangling" });
  assert.equal(res.status, 409, "something already holds the name (even a broken link)");
  assert.ok(!existsSync(join(OUTSIDE, "not-there-yet")), "and mkdir did not follow the link to its target");
});

test("confinement: `~` expands to home and stays inside the roots", async () => {
  const name = `.truss-mkdir-tilde-${process.pid}`;
  try {
    const res = await mkdir({ parent: "~", name });
    assert.equal(res.status, 201, "~ is the picker's home row, so it must work");
    const body = await res.json();
    assert.equal(body.path, join(homedir(), name), "the path comes back expanded, not as a literal ~");
    assert.ok(existsSync(join(homedir(), name)), "and it really exists");
  } finally {
    try {
      rmSync(join(homedir(), name), { recursive: true, force: true });
    } catch {}
  }
  const escape = await mkdir({ parent: "~", name: "../../truss-mkdir-escape" });
  assert.equal(escape.status, 400, "a traversal name is malformed input, not a permissions question");
});

test("the name matrix is enforced on the route, with nothing written", async () => {
  for (const name of [".", "..", "", "   ", "a/b", "a\\b", "../escape", "x".repeat(65), "nul\u0000x", "bell\u0007"]) {
    const res = await mkdir({ parent: WS, name });
    assert.equal(res.status, 400, `400 for ${JSON.stringify(name)} (got ${res.status})`);
  }
  assert.deepEqual(
    (await fetch(`${srv.base}/api/browse?path=${encodeURIComponent(WS)}`).then((r) => r.json())).dirs.map((d: any) => d.name).sort(),
    ["real"],
    "no garbage directory was created — the listing is exactly the fixture (escape-link is not offered: #106 hides links that leave the roots)",
  );
});

test("malformed bodies and a parent that is a file are refused cleanly", async () => {
  assert.equal((await mkdir({})).status, 400, "no parent/name");
  assert.equal((await mkdir({ parent: WS })).status, 400, "no name");
  assert.equal((await mkdir({ name: "orphan" })).status, 400, "no parent");
  assert.equal((await mkdir({ parent: WS, name: 42 })).status, 400, "name must be a string");
  assert.equal((await mkdir({ parent: 42, name: "x" })).status, 400, "parent must be a string");

  const file = join(WS, "not-a-dir.txt");
  writeFileSync(file, "x");
  const res = await mkdir({ parent: file, name: "under-a-file" });
  assert.ok([400, 403].includes(res.status), "a file is not a parent");
  assert.ok(!existsSync(join(file, "under-a-file")), "nothing written under a file");
});

test("trailing-slash parents still land inside the roots", async () => {
  const res = await mkdir({ parent: WS + "/", name: "trailing" });
  assert.equal(res.status, 201, "a trailing slash is a normal way to paste a path");
  const body = await res.json();
  assert.equal(body.path, join(WS, "trailing"), "the response is the normalized path");
  assert.ok(existsSync(join(WS, "trailing")), "created where it says");
});

test("duplicates are refused across a symlinked parent too", async () => {
  const name = "dupe-through-link";
  const link = join(WS, "inside-link");
  symlinkSync(WS, link); // a link INSIDE the roots, pointing inside the roots
  try {
    assert.equal((await mkdir({ parent: WS, name })).status, 201, "first create wins");
    assert.equal((await mkdir({ parent: link, name })).status, 409, "the same directory seen through a link is still the same directory");
    assert.ok(existsSync(join(WS, name)), "and the original survived untouched");
  } finally {
    rmSync(join(WS, "inside-link"), { force: true });
  }
});
