import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshServer } from "./helpers.js";

/* files.ts — workspace file browsing for the Files panel. Pure node:fs, no DB;
   the workspace root is a "ws" subdir of the freshServer dir because importing
   db.js drops truss.db* files into the freshServer dir itself. The security
   contract under test: every operation must refuse to resolve outside root. */

async function setup(tag: string) {
  const { dir, cleanup } = await freshServer(tag);
  const root = join(dir, "ws");
  mkdirSync(root, { recursive: true });
  const files = await import("../src/files.js");
  return { root, files, cleanup };
}

test("listDir: dirs first then files, real sizes, .git excluded, dotfiles kept", async () => {
  const { root, files, cleanup } = await setup("files-list");
  try {
    mkdirSync(join(root, "zdir"));
    mkdirSync(join(root, "adir"));
    writeFileSync(join(root, "adir", "inner.txt"), "nested");
    writeFileSync(join(root, "b.txt"), "xyz");
    writeFileSync(join(root, "a.txt"), "x");
    writeFileSync(join(root, ".env"), "SECRET=1"); // dotfiles are listed (only .git is special-cased)
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "x");

    const entries = files.listDir(root);
    assert.deepEqual(
      entries.map((e) => e.name),
      ["adir", "zdir", ".env", "a.txt", "b.txt"],
      "dirs first (alpha), then files (alpha); .git hidden, .env present",
    );
    const byName = new Map(entries.map((e) => [e.name, e]));
    assert.equal(byName.get("adir")!.kind, "dir");
    assert.equal(byName.get("adir")!.size, 0);
    assert.equal(byName.get("adir")!.path, "adir");
    assert.equal(byName.get("b.txt")!.kind, "file");
    assert.equal(byName.get("b.txt")!.size, 3);
    assert.equal(byName.get("b.txt")!.path, "b.txt");
    assert.ok(byName.get("b.txt")!.mtime > 0);

    // nested listing reports paths relative to root
    const inner = files.listDir(root, "adir");
    assert.deepEqual(inner.map((e) => [e.name, e.path]), [["inner.txt", "adir/inner.txt"]]);
  } finally {
    cleanup();
  }
});

test("readFile: text round trip, nested path, directory rejected", async () => {
  const { root, files, cleanup } = await setup("files-read");
  try {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "hello.txt"), "hello wörld\n");
    const r = files.readFile(root, "sub/hello.txt");
    assert.equal(r.kind, "text");
    assert.equal(r.text, "hello wörld\n");
    assert.equal(r.truncated, false);
    assert.equal(r.name, "hello.txt");
    assert.equal(r.path, "sub/hello.txt");
    assert.equal(r.size, Buffer.byteLength("hello wörld\n"));

    assert.throws(() => files.readFile(root, "sub"), /is a directory/);
    assert.throws(() => files.readFile(root, "nope.txt"), /ENOENT/);
  } finally {
    cleanup();
  }
});

test("readFile: classification — binary ext, NUL sniff, svg text, png image, big text truncated", async () => {
  const { root, files, cleanup } = await setup("files-classify");
  try {
    // extension on the binary list wins even over text content
    writeFileSync(join(root, "blob.bin"), "this is plain text really");
    assert.equal(files.readFile(root, "blob.bin").kind, "binary");

    // unknown extension with a NUL byte in the first 8KB sniffs as binary
    writeFileSync(join(root, "mystery"), Buffer.from([65, 66, 0, 67]));
    assert.equal(files.readFile(root, "mystery").kind, "binary");

    // svg is treated as editable text, other images as data URLs
    writeFileSync(join(root, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    const svg = files.readFile(root, "icon.svg");
    assert.equal(svg.kind, "text");
    assert.match(svg.text!, /<svg/);

    writeFileSync(join(root, "pix.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const png = files.readFile(root, "pix.png");
    assert.equal(png.kind, "image");
    assert.ok(png.dataUrl!.startsWith("data:image/png;base64,"));
    assert.equal(png.text, undefined);

    // text preview caps at 512KB and flags truncation
    const big = "a".repeat(512 * 1024 + 100);
    writeFileSync(join(root, "big.txt"), big);
    const capped = files.readFile(root, "big.txt");
    assert.equal(capped.kind, "text");
    assert.equal(capped.truncated, true);
    assert.equal(capped.text!.length, 512 * 1024);
    assert.equal(capped.size, 512 * 1024 + 100, "size reports the real file size");
  } finally {
    cleanup();
  }
});

test("write/create/search: write+read back, missing-file error, createPath, name search", async () => {
  const { root, files, cleanup } = await setup("files-write");
  try {
    // createPath makes parent dirs; writeFile then round-trips through readFile
    const created = files.createPath(root, "sub2/new.txt", "file");
    assert.equal(created.kind, "file");
    assert.equal(created.path, "sub2/new.txt");
    const wrote = files.writeFile(root, "sub2/new.txt", "fresh content");
    assert.equal(wrote.kind, "text");
    assert.equal(wrote.text, "fresh content");
    assert.equal(files.readFile(root, "sub2/new.txt").text, "fresh content");

    // writeFile refuses to create — that's createPath's job
    assert.throws(() => files.writeFile(root, "missing.txt", "x"), /does not exist \(use create\)/);
    assert.throws(() => files.writeFile(root, "sub2", "x"), /is a directory/);
    assert.throws(() => files.createPath(root, "sub2/new.txt", "file"), /already exists/);

    const newDir = files.createPath(root, "newdir", "dir");
    assert.equal(newDir.kind, "dir");

    // name search: substring, case-insensitive, skips node_modules
    writeFileSync(join(root, "sub2", "README-NEW.md"), "x");
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "new-secret.js"), "x");
    const hits = files.searchFiles(root, "new");
    const paths = hits.map((h) => h.path).sort();
    assert.deepEqual(paths, ["newdir", "sub2/README-NEW.md", "sub2/new.txt"], "node_modules stayed out");
  } finally {
    cleanup();
  }
});

test("confinement: lexical escapes AND symlink escapes refused everywhere", async () => {
  const { root, files, cleanup } = await setup("files-confine");
  const outside = mkdtempSync(join(tmpdir(), "truss-test-outside-"));
  try {
    writeFileSync(join(root, "ok.txt"), "ok");
    const escapes = ["..", "../..", "../../etc", "/etc", "ok.txt/../../..", "sub/../../outside"];
    for (const p of escapes) {
      assert.throws(() => files.listDir(root, p), /escapes the workspace root/, `listDir(${p})`);
      assert.throws(() => files.readFile(root, p), /escapes the workspace root/, `readFile(${p})`);
      assert.throws(() => files.writeFile(root, p, "x"), /escapes the workspace root/, `writeFile(${p})`);
      assert.throws(() => files.createPath(root, p, "file"), /escapes the workspace root/, `createPath(${p})`);
    }
    // and a missing root is an error, not the process cwd
    assert.throws(() => files.listDir(""), /missing workspace root/);

    // a symlink inside the root pointing outside is refused too (realpath of
    // the deepest existing ancestor must stay under the root)
    writeFileSync(join(outside, "secret.txt"), "escaped-secret");
    symlinkSync(outside, join(root, "link"));
    assert.throws(() => files.readFile(root, "link/secret.txt"), /escapes the workspace root/, "readFile through escaping symlink");
    assert.throws(() => files.listDir(root, "link"), /escapes the workspace root/, "listDir through escaping symlink");
    assert.throws(() => files.writeFile(root, "link/evil.txt", "x"), /escapes the workspace root/, "writeFile through escaping symlink");

    // a symlink pointing INSIDE the root still works
    mkdirSync(join(root, "real-dir"));
    writeFileSync(join(root, "real-dir", "in.txt"), "inside");
    symlinkSync(join(root, "real-dir"), join(root, "inner-link"));
    assert.equal(files.readFile(root, "inner-link/in.txt").text, "inside", "in-root symlink allowed");
  } finally {
    rmSync(outside, { recursive: true, force: true });
    cleanup();
  }
});
