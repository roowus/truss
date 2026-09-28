import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* practices.ts binds GLOBAL_DIR = join(homedir(), ".truss") AT IMPORT TIME,
   so HOME must point at a throwaway dir BEFORE the module is first imported —
   and the import must be dynamic (static imports hoist above the env set).
   One module instance per test process, so the whole file shares this HOME;
   tests below are order-sensitive on purpose: the global TRUSS.md only exists
   after the round-trip test creates it. The real ~/.truss is never touched. */

const HOME = mkdtempSync(join(tmpdir(), "truss-test-practices-home-"));
process.env.HOME = HOME;

const { composePractices, getGlobalPractices, saveGlobalPractices, POSTING_GUIDE } = await import(
  "../src/practices.js"
);

const GLOBAL_FILE = join(HOME, ".truss", "TRUSS.md");
const PROJECTS_DIR = join(HOME, ".truss", "projects");

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* tmp dirs get reaped anyway */
  }
});

test("global: missing file -> getGlobalPractices returns the built-in default", () => {
  const g = getGlobalPractices();
  assert.ok(g.length > 0);
  assert.ok(g.includes("# Truss practices"));
  // POSTING_GUIDE is always available regardless of files on disk
  assert.ok(POSTING_GUIDE.includes("file_todo"));
  assert.ok(POSTING_GUIDE.includes("post_feed"));
});

test("compose: no files anywhere -> no layers, empty composed", () => {
  const r = composePractices();
  assert.deepEqual(r.layers, []);
  assert.equal(r.composed, "");
});

test("global: saveGlobalPractices + getGlobalPractices round trip", () => {
  saveGlobalPractices("# house rules\n- be terse\n");
  assert.equal(getGlobalPractices(), "# house rules\n- be terse\n");
});

test("compose: saved global appears as the global layer with a provenance marker", () => {
  const r = composePractices();
  assert.equal(r.layers.length, 1);
  assert.equal(r.layers[0].scope, "global");
  assert.equal(r.layers[0].path, GLOBAL_FILE);
  // marker format: <!-- <scope>: <path> -->\n<text.trim()>
  assert.ok(r.composed.startsWith(`<!-- global: ${GLOBAL_FILE} -->\n`));
  assert.ok(r.composed.includes("be terse"));
});

test("folders: TRUSS.md chain composes outer -> inner, global first", () => {
  const outer = join(HOME, "outer");
  const inner = join(outer, "inner");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(outer, "TRUSS.md"), "outer rules");
  writeFileSync(join(inner, "TRUSS.md"), "inner rules");

  const r = composePractices(inner);
  assert.deepEqual(
    r.layers.map((l) => l.scope),
    ["global", "folder", "folder"],
  );
  const folders = r.layers.filter((l) => l.scope === "folder");
  assert.equal(folders[0].path, join(outer, "TRUSS.md"));
  assert.equal(folders[1].path, join(inner, "TRUSS.md"));

  // composed order: global, then outer, then inner; layers joined by "\n\n---\n\n"
  const gi = r.composed.indexOf("be terse");
  const oi = r.composed.indexOf("outer rules");
  const ii = r.composed.indexOf("inner rules");
  assert.ok(gi !== -1 && oi !== -1 && ii !== -1);
  assert.ok(gi < oi && oi < ii);
  assert.ok(r.composed.includes("\n\n---\n\n"));
  assert.ok(r.composed.includes(`<!-- folder: ${join(outer, "TRUSS.md")} -->`));
  assert.ok(r.composed.includes(`<!-- folder: ${join(inner, "TRUSS.md")} -->`));
});

test("folders: a TRUSS.md directly in $HOME is NOT picked up (walk excludes home itself)", () => {
  writeFileSync(join(HOME, "TRUSS.md"), "home-root rules");
  // cwd deeper than home: chain stops at $HOME, so the home-root file is skipped
  const r = composePractices(join(HOME, "outer", "inner"));
  assert.ok(!r.composed.includes("home-root rules"));
  // cwd == home: the folder chain is empty entirely
  const atHome = composePractices(HOME);
  assert.deepEqual(
    atHome.layers.map((l) => l.scope),
    ["global"],
  );
});

test("folders: cwd outside $HOME yields no folder layers", () => {
  const outside = mkdtempSync(join(tmpdir(), "truss-test-practices-outside-"));
  writeFileSync(join(outside, "TRUSS.md"), "outside rules");
  try {
    const r = composePractices(outside);
    assert.deepEqual(
      r.layers.map((l) => l.scope),
      ["global"],
    );
    assert.ok(!r.composed.includes("outside rules"));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("project: ~/.truss/projects/<name>.md layers between global and folders; name is sanitized", () => {
  mkdirSync(PROJECTS_DIR, { recursive: true });
  writeFileSync(join(PROJECTS_DIR, "demo.md"), "project rules");
  writeFileSync(join(PROJECTS_DIR, "my_proj_x.md"), "sanitized project rules");

  const r = composePractices(join(HOME, "outer", "inner"), "demo");
  assert.deepEqual(
    r.layers.map((l) => l.scope),
    ["global", "project", "folder", "folder"],
  );
  assert.equal(r.layers[1].path, join(PROJECTS_DIR, "demo.md"));
  assert.ok(r.composed.includes(`<!-- project: ${join(PROJECTS_DIR, "demo.md")} -->`));

  // unsafe chars in the project name collapse to "_" before the file lookup
  const sanitized = composePractices(undefined, "my proj/x");
  const proj = sanitized.layers.find((l) => l.scope === "project");
  assert.ok(proj);
  assert.equal(proj.path, join(PROJECTS_DIR, "my_proj_x.md"));

  // a project with no file on disk contributes no layer
  const missing = composePractices(undefined, "nonexistent");
  assert.deepEqual(
    missing.layers.map((l) => l.scope),
    ["global"],
  );
});
