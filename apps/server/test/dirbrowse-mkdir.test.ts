import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer, type TestServer } from "./server-harness.js";
import { freshServer } from "./helpers.js";

/* SPEC-TESTS for creating a folder from the session picker —
   https://github.com/roowus/truss/issues/233
   ("When creating sessions, let the user create a new folder in a directory
   as well"). These FAIL on purpose today: they pin the contract a fix must
   satisfy.

   Today: the picker (#106) browses and picks — read-only. dirbrowse.ts
   exports browseRoots/listDirs (confined); there is no mkdir.

   The contract:

   1. pure — dirbrowse.ts gains validDirName(name): string | null
      — a SINGLE path segment: trimmed, 1–64 chars, no "/" or "\", never
        "." or "..", no control chars/NUL; null when invalid (the caller
        shows why);
   2. route — POST /api/browse/mkdir { parent, name }:
      → 201 { path }; the created dir sits INSIDE the browse roots (the same
        confinement as listDirs — escapes and outside-roots parents are
        refused); invalid names → 400; an existing path → 409 (never
        clobbered, never merged silently); parent missing → 400/404. */

interface DirBrowseMkdirModule {
  validDirName(name: string): string | null;
}

async function load(): Promise<DirBrowseMkdirModule | null> {
  const { cleanup } = await freshServer("mkdir-mod");
  try {
    const spec = "../src/dirbrowse.js"; // the module exists; the export is the contract
    const mod: any = await import(spec);
    return typeof mod?.validDirName === "function" ? mod : null;
  } finally {
    cleanup();
  }
}

test("validDirName: one clean path segment or null", async () => {
  const mod = await load();
  assert.ok(mod, "dirbrowse.ts must export validDirName — see issue #233");

  assert.equal(mod.validDirName("  my-project  "), "my-project", "trimmed");
  assert.equal(mod.validDirName("a b c"), "a b c", "spaces are fine inside a name");
  assert.equal(mod.validDirName(".."), null, "never a traversal");
  assert.equal(mod.validDirName("."), null);
  assert.equal(mod.validDirName("a/b"), null, "one segment only");
  assert.equal(mod.validDirName("a\\b"), null);
  assert.equal(mod.validDirName(""), null);
  assert.equal(mod.validDirName("   "), null);
  assert.equal(mod.validDirName("x".repeat(65)), null, "capped at 64");
  assert.equal(mod.validDirName("ok" + String.fromCharCode(0) + "x"), null, "no NULs");
  assert.equal(mod.validDirName("bad\u0007name"), null, "no control chars");
});

/* ── the live route ── */

let srv: TestServer;
before(async () => {
  srv = await bootServer("mkdir-live");
});
after(async () => {
  await srv.close();
});

test("POST /api/browse/mkdir: creates inside the roots; refuses escapes/dupes/garbage", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const parent = mkdtempSync(join(tmpdir(), "truss-mkdir-"));
  try {
    const res = await fetch(`${srv.base}/api/browse/mkdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent, name: "fresh-folder" }),
    });
    assert.equal(res.status, 201, "the mkdir route exists (issue #233)");
    const body = await res.json();
    assert.equal(body.path, join(parent, "fresh-folder"), "the created path comes back");
    const { statSync } = await import("node:fs");
    assert.ok(statSync(body.path).isDirectory(), "and it really exists as a directory");

    /* it then LISTS through the same browse surface — the picker can enter it */
    const listed = await fetch(`${srv.base}/api/browse?path=${encodeURIComponent(parent)}`).then((r) => r.json());
    assert.ok((listed.dirs ?? []).some((d: any) => d.name === "fresh-folder"), "the new folder appears in the listing");

    /* duplicates never clobber */
    const dupe = await fetch(`${srv.base}/api/browse/mkdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent, name: "fresh-folder" }),
    });
    assert.equal(dupe.status, 409, "an existing path is refused, never merged");

    /* escapes outside the roots are refused exactly like browsing */
    const escape = await fetch(`${srv.base}/api/browse/mkdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent: "/etc", name: "nope" }),
    });
    assert.ok([400, 403].includes(escape.status), "outside the roots → refused");
    const traversal = await fetch(`${srv.base}/api/browse/mkdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent, name: "../escape" }),
    });
    assert.ok([400, 403].includes(traversal.status), "a traversal name → refused");

    const garbage = await fetch(`${srv.base}/api/browse/mkdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent, name: "   " }),
    });
    assert.equal(garbage.status, 400, "blank → 400 with a reason");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
