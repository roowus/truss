import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { freshServer } from "./helpers.js";

/* SPEC-TESTS for the session-creation directory browser —
   https://github.com/roowus/truss/issues/106
   ("When creating a session and you have to give a working directory: add a
   way to explore the directory structure and choose, and have a default
   directory too"). These FAIL on purpose today: they pin the contract a fix
   must satisfy.

   Today the New Session dialog's cwd is a free-text input with validation
   by hope (NewSessionDialog.tsx:148-149). A picker needs a server-side
   directory browser — and it must be boringly safe: directory NAMES only
   (never file contents), confined to a root set, escape-proof.

   The contract: a new src/dirbrowse.ts —

     browseRoots(): string[]                  // where the picker may start
     listDirs(absPath: string): { dirs: { name: string; path: string }[]; parent: string | null }

   Rules it must honor:
   - directories only, sorted by name, hidden dirs skipped by default
     (a `showHidden` opt includes them), `..` never listed as a child (the
     parent link rides `parent` instead);
   - CONFINED to browseRoots(): anything outside throws; symlink escapes
     throw too (the files.ts confine rule, same spirit);
   - a file path or a missing dir throws a clean "not a directory"-class
     error — never a stack, never partial data;
   - browseRoots leads with the user's home and only lists real dirs. */

interface DirBrowseModule {
  browseRoots(): string[];
  listDirs(absPath: string, opts?: { showHidden?: boolean }): { dirs: { name: string; path: string }[]; parent: string | null };
}

async function load(): Promise<DirBrowseModule | null> {
  const spec = "../src/dirbrowse.js"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

let WS: string;
{
  /* a fixture tree under a browsable root (/tmp is one) */
  WS = mkdtempSync(join(tmpdir(), "truss-browse-"));
  mkdirSync(join(WS, "alpha", "deep"), { recursive: true });
  mkdirSync(join(WS, "beta"));
  mkdirSync(join(WS, ".hidden"));
  writeFileSync(join(WS, "a-file.txt"), "not a dir");
  symlinkSync(join(WS, "alpha"), join(WS, "alpha-link"));
}
after(() => {
  try {
    rmSync(WS, { recursive: true, force: true });
  } catch {}
});

test("src/dirbrowse.ts exists; roots lead with home and are all real dirs", async () => {
  const { cleanup } = await freshServer("browse-mod");
  try {
    const mod = await load();
    assert.ok(mod, "src/dirbrowse.js must export browseRoots/listDirs — see issue #106");
    const roots = mod.browseRoots();
    assert.ok(roots.length >= 1, "at least one root");
    assert.match(roots[0], /^\/(home|Users)\//, "home first — that's where people's code lives");
  } finally {
    cleanup();
  }
});

test("listDirs: directories only, sorted, hidden skipped, parent rides along", async () => {
  const { cleanup } = await freshServer("browse-list");
  try {
    const mod = await load();
    assert.ok(mod, "dirbrowse module must exist (see roots test)");

    const r = mod.listDirs(WS);
    assert.deepEqual(
      r.dirs.map((d) => d.name),
      ["alpha", "alpha-link", "beta"],
      "dirs only (the file is absent), sorted, hidden skipped, the symlinked dir follows",
    );
    assert.ok(r.dirs.every((d) => d.path.startsWith(WS)), "paths are absolute children");
    assert.equal(r.parent, tmpdir(), "the parent rides along for the up-button");
    assert.ok(!r.dirs.some((d) => d.name === ".." || d.name === "."), "no dot-entry clutter");

    const withHidden = mod.listDirs(WS, { showHidden: true });
    assert.ok(withHidden.dirs.some((d) => d.name === ".hidden"), "the toggle reveals dotdirs");
  } finally {
    cleanup();
  }
});

test("confinement: outside the roots and symlink escapes are refused", async () => {
  const { cleanup } = await freshServer("browse-confine");
  try {
    const mod = await load();
    assert.ok(mod, "dirbrowse module must exist (see roots test)");

    assert.throws(() => mod.listDirs("/etc"), /outside|root|allow|confine/i, "system dirs are out of bounds");
    assert.throws(() => mod.listDirs("/"), /outside|root|allow|confine/i, "even / — the picker starts at roots");
    assert.throws(() => mod.listDirs(join(WS, "..", "..")), /outside|root|allow|confine/i, "lexical escapes die");

    /* a symlink inside the tree pointing OUTSIDE the roots */
    const escape = join(WS, "escape-link");
    symlinkSync("/etc", escape);
    assert.throws(() => mod.listDirs(escape), /outside|root|allow|confine|symlink/i, "symlink escapes die too");
  } finally {
    cleanup();
  }
});

test("clean errors: a file path or a missing dir never returns garbage", async () => {
  const { cleanup } = await freshServer("browse-errors");
  try {
    const mod = await load();
    assert.ok(mod, "dirbrowse module must exist (see roots test)");
    assert.throws(() => mod.listDirs(join(WS, "a-file.txt")), /not a directory|directory/i, "a file is not browsable");
    assert.throws(() => mod.listDirs(join(WS, "gone")), /not|missing|exist|directory/i, "missing dir, clean message");
  } finally {
    cleanup();
  }
});
