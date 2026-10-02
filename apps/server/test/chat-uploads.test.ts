import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { freshServer } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";

/* Tests for chat file upload — https://github.com/roowus/truss/issues/2
   ("Chat sessions should allow file upload"). Written as spec-tests against
   the contract below; the fix has landed and they now pin it.

   The contract, two pieces:

   1. src/uploads.ts (new) — saveUpload(root, name, data, opts?) stores an
      uploaded file INSIDE the session workspace: binary byte-exact, hostile
      names neutralized to a basename, collisions deduped (never overwrite),
      size-capped with nothing left behind on reject. Returns
      { name, path, size } with `path` relative to root. Security mirrors
      files.ts: the session's cwd is the trust boundary.

   2. sendPrompt(sessionId, text, attachments?) — attachments ride the prompt:
      the adapter-bound text references each file's workspace path (text-only
      harnesses like pi must still find the files), and the persisted user
      echo (msg.start) carries the attachment refs so transcript chips survive
      reload. Calling WITHOUT attachments keeps today's exact behavior
      (backward-compat guard — that one is green already and must stay so).

   Safety: everything happens under per-test tmp dirs; no harness is spawned
   (a recording fake adapter stands in). */

interface UploadsModule {
  saveUpload(root: string, name: string, data: Buffer, opts?: { maxBytes?: number }): { name: string; path: string; size: number };
}

async function loadUploads(): Promise<UploadsModule | null> {
  const spec = "../src/uploads.js"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

async function setup(tag: string) {
  const { dir, db, cleanup } = await freshServer(tag);
  const root = join(dir, "ws");
  mkdirSync(root, { recursive: true });
  return { root, db, cleanup };
}

/** every file under dir, rel paths — before/after snapshots for the no-leftovers assertions */
function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, d.name);
    if (d.isDirectory()) out.push(...walkFiles(abs, base));
    else out.push(abs.slice(base.length + 1));
  }
  return out.sort();
}

/* ── 1. the upload store ── */

test("saveUpload stores exact bytes inside the workspace, reports a root-relative path", async () => {
  const { root, cleanup } = await setup("up-store");
  try {
    const uploads = await loadUploads();
    assert.ok(uploads, "src/uploads.ts must exist — chat uploads need a confined, binary-safe store (see issue #2)");

    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]); // binary, NULs included
    const saved = uploads.saveUpload(root, "shot.png", data);

    assert.equal(saved.name, "shot.png");
    assert.equal(saved.size, data.length);
    assert.ok(saved.path.length > 0, "returns where it landed");
    assert.ok(!saved.path.startsWith("/") && !saved.path.split(/[\\/]/).includes(".."), "path is relative to the workspace root");
    const abs = join(root, saved.path);
    assert.ok(existsSync(abs), "file exists at the reported path");
    assert.deepEqual(readFileSync(abs), data, "byte-exact — binary uploads must survive");
  } finally {
    cleanup();
  }
});

test("saveUpload neutralizes hostile names to a basename inside the root; rejects empty names", async () => {
  const { root, cleanup } = await setup("up-names");
  try {
    const uploads = await loadUploads();
    assert.ok(uploads, "src/uploads.ts must exist (see storage test)");

    for (const nasty of ["../../etc/truss-pwn", "..\\..\\win.ini", "/abs/path.txt", "a/../../b.sh"]) {
      const s = uploads.saveUpload(root, nasty, Buffer.from("x"));
      assert.ok(!s.path.startsWith("/"), `${nasty}: not absolute`);
      assert.ok(!s.path.split(/[\\/]/).includes(".."), `${nasty}: no traversal left in the stored path`);
      assert.equal(s.name, s.name.split(/[\\/]/).pop(), `${nasty}: name reduced to a basename`);
      assert.ok(!s.name.includes(".."), `${nasty}: traversal gone from the name`);
      assert.ok(existsSync(join(root, s.path)), `${nasty}: landed inside the root`);
    }

    assert.throws(() => uploads.saveUpload(root, "", Buffer.from("x")), /name/i, "empty name rejected with a useful message");
    assert.throws(() => uploads.saveUpload(root, "   ", Buffer.from("x")), /name/i, "blank name rejected");
  } finally {
    cleanup();
  }
});

test("saveUpload dedupes collisions instead of overwriting", async () => {
  const { root, cleanup } = await setup("up-dupe");
  try {
    const uploads = await loadUploads();
    assert.ok(uploads, "src/uploads.ts must exist (see storage test)");

    const a = uploads.saveUpload(root, "log.txt", Buffer.from("first"));
    const b = uploads.saveUpload(root, "log.txt", Buffer.from("second"));
    assert.notEqual(a.path, b.path, "same name twice → two distinct files (an earlier upload is evidence; never clobber it)");
    assert.equal(readFileSync(join(root, a.path), "utf8"), "first", "original untouched");
    assert.equal(readFileSync(join(root, b.path), "utf8"), "second");
  } finally {
    cleanup();
  }
});

test("saveUpload enforces maxBytes and leaves nothing behind on reject", async () => {
  const { root, cleanup } = await setup("up-cap");
  try {
    const uploads = await loadUploads();
    assert.ok(uploads, "src/uploads.ts must exist (see storage test)");

    const before = walkFiles(root);
    assert.throws(
      () => uploads.saveUpload(root, "huge.bin", Buffer.alloc(64), { maxBytes: 32 }),
      /too large|maxbytes|size|exceed/i,
      "oversize rejected with a useful message (composer shows it)",
    );
    assert.deepEqual(walkFiles(root), before, "a rejected upload must not leak partial files");
  } finally {
    cleanup();
  }
});

test("saveUpload refuses a .truss-uploads symlink that escapes the workspace (issue #2 security notes)", async () => {
  const { root, cleanup } = await setup("up-symlink");
  try {
    const uploads = await loadUploads();
    assert.ok(uploads, "src/uploads.ts must exist (see storage test)");

    /* the harness runs code inside the workspace and can plant the upload dir
       as a symlink out; the unsandboxed server must not write through it */
    const outside = join(root, "..", "outside-up-symlink");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, ".truss-uploads"), "dir");

    assert.throws(
      () => uploads!.saveUpload(root, "loot.txt", Buffer.from("x")),
      /escapes|symlink/i,
      "a symlinked upload dir pointing outside the workspace is refused",
    );
    assert.deepEqual(readdirSync(outside), [], "nothing written through the symlink");
  } finally {
    cleanup();
  }
});

/* ── 2. attachments ride the prompt ── */

interface FakeRec {
  sent: string[];
}

function fakeAdapter(id: string, rec: FakeRec): HarnessAdapter {
  return {
    id: id as never,
    capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true },
    async listModels() {
      return [];
    },
    async spawn(opts: SessionOpts): Promise<AdapterHandle> {
      return { sessionId: opts.sessionId };
    },
    send(_h: AdapterHandle, text: string) {
      rec.sent.push(text);
    },
    interrupt() {},
    async *events() {
      await new Promise(() => {});
      yield undefined as never;
    },
    dispose() {},
  };
}

test("sendPrompt(id, text, attachments) — adapter text references the files; user echo persists them", async () => {
  const { root, db, cleanup } = await setup("up-prompt");
  try {
    const sessions = await import("../src/sessions.js");
    const rec: FakeRec = { sent: [] };
    sessions.registerAdapter("fake-up" as never, fakeAdapter("fake-up", rec));
    try {
      const s = await sessions.createSession({ harness: "fake-up" as never, cwd: root });
      const attachments = [
        { name: "error.log", path: ".truss-uploads/error.log", size: 1234, mime: "text/plain" },
        { name: "shot.png", path: ".truss-uploads/shot-1.png", size: 56789, mime: "image/png" },
      ];
      /* sendPrompt's third parameter is the new contract — the cast keeps
         this file typechecking before the signature exists */
      await (sessions.sendPrompt as unknown as (id: string, text: string, atts: unknown[]) => Promise<void>)(
        s.id,
        "what's in this log?",
        attachments,
      );

      const outbound = rec.sent.at(-1)!;
      assert.ok(outbound.includes("what's in this log?"), "user text preserved");
      for (const a of attachments) {
        assert.ok(outbound.includes(a.path), `adapter-bound text references ${a.path} — text-only harnesses (pi) must still find the file`);
      }

      const userStart = db.store
        .listEvents(s.id)
        .map((f) => f.ev)
        .find((e) => e.type === "msg.start" && (e as { role?: string }).role === "user");
      assert.ok(userStart, "user echo persisted");
      assert.deepEqual(
        (userStart as { attachments?: unknown }).attachments,
        attachments,
        "msg.start carries the attachment refs — transcript chips survive reload",
      );
    } finally {
      sessions.unregisterAdapter("fake-up" as never);
    }
  } finally {
    cleanup();
  }
});

test("sendPrompt without attachments stays exactly as today (backward-compat guard — green already)", async () => {
  const { root, db, cleanup } = await setup("up-compat");
  try {
    const sessions = await import("../src/sessions.js");
    const rec: FakeRec = { sent: [] };
    sessions.registerAdapter("fake-compat" as never, fakeAdapter("fake-compat", rec));
    try {
      const s = await sessions.createSession({ harness: "fake-compat" as never, cwd: root });
      await sessions.sendPrompt(s.id, "plain message");

      assert.ok(rec.sent.at(-1)!.includes("plain message"), "adapter text unchanged");
      const userStart = db.store
        .listEvents(s.id)
        .map((f) => f.ev)
        .find((e) => e.type === "msg.start" && (e as { role?: string }).role === "user") as unknown as Record<string, unknown>;
      assert.ok(userStart, "user echo persisted");
      assert.ok(!("attachments" in userStart) || userStart.attachments === undefined, "no attachments field appears when none were sent");
    } finally {
      sessions.unregisterAdapter("fake-compat" as never);
    }
  } finally {
    cleanup();
  }
});
