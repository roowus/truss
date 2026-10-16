import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for copyable chat references — https://github.com/roowus/truss/issues/13
   ("Copy a chat id that includes harness, host, directory and session id, to
   paste into another chat as a reference"). These FAIL on purpose today:
   they pin the contract a fix must satisfy.

   Today a session's identity lives in tooltip glue (ChatPanel.tsx:70-72) and
   nowhere copyable — referencing another chat means describing it by hand.

   The contract: a pure src/lib/sessionRef.ts —

     formatSessionRef(meta, hosts?) → string
       meta:  { id, harness, cwd }   (harness may be "<base>@<hostId>" for
             remote sessions; hosts resolves that id to its label)
       → one line: `#<id> · <baseHarness>[ @ <hostLabel>] · <shortPath cwd>`
       e.g. `#3f9a1c2e · pi @ fedora box · ~/code/api`
       The host is the LABEL (deviceLabel semantics: hosts list → label,
       raw id when unknown); local sessions carry no host part.

     parseSessionRef(text) → { sessionId, harness?, host?, cwd? } | null
       Built for paste-into-chat: finds the reference EMBEDDED IN PROSE,
       round-trips what formatSessionRef emits, accepts a bare "#<id>",
       and returns null (never throws) on anything else.

   The copy affordance itself (header ⋯ menu entry, clipboard write) is
   covered by the issue's acceptance criteria, not here. */

interface SessionMetaLike {
  id: string;
  harness: string;
  cwd: string;
}
interface HostLike {
  id: string;
  label: string;
}
interface ParsedRef {
  sessionId: string;
  harness?: string;
  host?: string;
  cwd?: string;
}
interface SessionRefModule {
  formatSessionRef(meta: SessionMetaLike, hosts?: HostLike[]): string;
  parseSessionRef(text: string): ParsedRef | null;
}

/* SPEC-TESTS for the FULL identity block — https://github.com/roowus/truss/issues/132
   ("Copy reference should carry the full identity: truss id + harness uuid +
   host id + full cwd (one-liner stays first, byte-identical)"). These FAIL on
   purpose today: they pin the contract a fix must satisfy.

   The one-liner (#13) is pinned separately above and must not move; the full
   block puts it on line 1 UNCHANGED, then labels every id we hold — including
   the harness's own uuid (harness_ref) — plus the unshortened cwd. Missing
   fields are simply absent; undefined/null never leak into the text. */

interface SessionMetaFull {
  id: string;
  harness: string;
  cwd: string;
  harness_ref?: string | null;
}
interface SessionRefFullModule {
  formatSessionRef(meta: SessionMetaLike, hosts?: HostLike[]): string;
  formatSessionRefFull(meta: SessionMetaFull, hosts?: HostLike[]): string;
  parseSessionRef(text: string): ParsedRef | null;
}

async function load(): Promise<SessionRefModule | null> {
  const spec = "../src/lib/sessionRef"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

const LOCAL: SessionMetaLike = { id: "3f9a1c2e", harness: "hermes", cwd: "/home/ubuntu/projects/truss" };
const REMOTE: SessionMetaLike = { id: "aa07c1d9", harness: "pi@6b260ee1", cwd: "/home/fedora/code/api" };
const HOSTS: HostLike[] = [{ id: "6b260ee1", label: "fedora box" }];

test("src/lib/sessionRef.ts exists with format + parse", async () => {
  const ref = await load();
  assert.ok(ref, "src/lib/sessionRef.ts must export formatSessionRef/parseSessionRef — see issue #13");
  assert.equal(typeof ref.formatSessionRef, "function");
  assert.equal(typeof ref.parseSessionRef, "function");
});

test("formatSessionRef: id, harness, and home-shortened directory on one line", async () => {
  const ref = await load();
  assert.ok(ref, "sessionRef module must exist (see module test)");
  const s = ref.formatSessionRef(LOCAL);
  assert.ok(s.includes("#3f9a1c2e"), "carries the session id, #-marked");
  assert.ok(s.includes("hermes"), "carries the harness");
  assert.ok(s.includes("~/projects/truss"), "home collapses to ~ (shortPath semantics)");
  assert.ok(!s.includes("\n"), "single line — paste-safe");
});

test("formatSessionRef: remote sessions name the HOST LABEL and the base harness (not harness@hostId)", async () => {
  const ref = await load();
  assert.ok(ref, "sessionRef module must exist (see module test)");
  const s = ref.formatSessionRef(REMOTE, HOSTS);
  assert.ok(s.includes("#aa07c1d9"));
  assert.ok(s.includes("fedora box"), "host id resolves to its label");
  assert.ok(/\bpi\b/.test(s), "base harness present");
  assert.ok(!s.includes("6b260ee1"), "raw host id never leaks into the human reference");
  /* unknown host falls back to the raw id (deviceLabel rule) */
  assert.ok(ref.formatSessionRef(REMOTE, []).includes("6b260ee1"), "unknown host → raw id, still resolvable");
});

test("parse round-trips the formatted reference, fields intact", async () => {
  const ref = await load();
  assert.ok(ref, "sessionRef module must exist (see module test)");
  const local = ref.parseSessionRef(ref.formatSessionRef(LOCAL));
  assert.equal(local?.sessionId, "3f9a1c2e");
  assert.equal(local?.harness, "hermes");
  assert.equal(local?.cwd, "~/projects/truss");
  assert.equal(local?.host, undefined, "local session: no host part");

  const remote = ref.parseSessionRef(ref.formatSessionRef(REMOTE, HOSTS));
  assert.equal(remote?.sessionId, "aa07c1d9");
  assert.equal(remote?.harness, "pi");
  assert.equal(remote?.host, "fedora box");
  assert.equal(remote?.cwd, "~/code/api");
});

test("parseSessionRef finds a reference embedded in prose — that's the whole paste-into-a-chat flow", async () => {
  const ref = await load();
  assert.ok(ref, "sessionRef module must exist (see module test)");
  const sentence = `can you pick up where ${ref.formatSessionRef(REMOTE, HOSTS)} left off?`;
  assert.equal(ref.parseSessionRef(sentence)?.sessionId, "aa07c1d9");
});

async function loadFull(): Promise<SessionRefFullModule | null> {
  const spec = "../src/lib/sessionRef"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

const FULL: SessionMetaFull = {
  id: "aa07c1d9",
  harness: "pi@525b9cd4",
  cwd: "/Users/alice/projects/doubletake",
  harness_ref: "01a0edfd-6598-727a-99ee-15ab86352a3c",
};
const FULL_HOSTS: HostLike[] = [{ id: "525b9cd4", label: "devbox" }];

test("formatSessionRefFull: line 1 is the #13 one-liner BYTE-IDENTICAL; every id labeled; full cwd; parses back", async () => {
  const ref = await loadFull();
  assert.ok(ref, "sessionRef module must export formatSessionRefFull — see issue #132");
  assert.equal(typeof ref.formatSessionRefFull, "function");

  const one = ref.formatSessionRef(FULL, FULL_HOSTS);
  const full = ref.formatSessionRefFull(FULL, FULL_HOSTS);
  const lines = full.split("\n");

  assert.equal(lines[0], one, "line 1 must be formatSessionRef() byte-for-byte — the #13 contract is frozen");
  assert.ok(full.startsWith(`${one}\n`), "the detail block starts on line 2");

  /* every id we hold, labeled */
  assert.ok(/^truss: aa07c1d9$/m.test(full), "truss id labeled");
  assert.ok(/^pi session: 01a0edfd-6598-727a-99ee-15ab86352a3c$/m.test(full), "harness's own uuid labeled");
  assert.ok(/^host: 525b9cd4$/m.test(full), "host ID (not the human label) labeled — the resolvable one");
  assert.ok(/^cwd: \/Users\/alice\/projects\/doubletake$/m.test(full), "cwd is FULL — no ~ shortening in the detail block");
  assert.equal(lines.filter((l) => l.includes("~")).length, 1, "the ~-shortened path lives on line 1 only");
  assert.equal(lines[1], "truss: aa07c1d9", "the home-shortened path never reappears in the block");

  /* the block still parses back to the session id (and keeps the #13 fields) */
  const back = ref.parseSessionRef(full);
  assert.equal(back?.sessionId, "aa07c1d9");
  assert.equal(back?.harness, "pi");
  assert.equal(back?.host, "devbox");
  assert.equal(back?.cwd, "~/projects/doubletake");
  assert.ok(full.includes("01a0edfd-6598-727a-99ee-15ab86352a3c"), "the harness uuid survives the round trip as text");
});

test("formatSessionRefFull: never fabricates — a missing field is absent, not undefined/null", async () => {
  const ref = await loadFull();
  assert.ok(ref, "sessionRef module must export formatSessionRefFull — see issue #132");

  /* local session, no harness_ref: no host line (local sessions have no host
     id) and no harness line — and no literal "undefined"/"null" anywhere */
  const bare = ref.formatSessionRefFull({ id: "3f9a1c2e", harness: "hermes", cwd: "/home/ubuntu/projects/truss" });
  assert.equal(bare.split("\n")[0], ref.formatSessionRef({ id: "3f9a1c2e", harness: "hermes", cwd: "/home/ubuntu/projects/truss" }));
  assert.ok(!/^(host|hermes session):/m.test(bare), "no host/harness lines when we hold neither id");
  assert.ok(/^truss: 3f9a1c2e$/m.test(bare), "the truss id is always there — it's the identity");
  assert.ok(/^cwd: \/home\/ubuntu\/projects\/truss$/m.test(bare));
  assert.ok(!/\b(undefined|null)\b/.test(bare), "missing fields are absent, never rendered as undefined/null");

  /* null and empty-string refs are missing too — same rule, no exception */
  for (const missing of [null, undefined, ""]) {
    const s = ref.formatSessionRefFull({ ...FULL, harness_ref: missing });
    assert.ok(!/^pi session:/m.test(s), `${JSON.stringify(missing)} harness_ref → no harness line`);
    assert.ok(!/\b(undefined|null)\b/.test(s), `${JSON.stringify(missing)} harness_ref → no undefined/null leak`);
  }

  /* a host id with no registry entry still prints (raw id is resolvable) —
     the block never silently drops an id just because its label is unknown */
  const unknown = ref.formatSessionRefFull(FULL, []);
  assert.ok(/^host: 525b9cd4$/m.test(unknown), "unknown host keeps the raw id we hold");

  assert.ok(!ref.formatSessionRefFull({ id: "3f9a1c2e", harness: "hermes", cwd: "" }).includes("cwd:"), "no cwd, no cwd line");
});

test("parseSessionRef: bare #id works, junk is null, never throws", async () => {
  const ref = await load();
  assert.ok(ref, "sessionRef module must exist (see module test)");
  const bare = ref.parseSessionRef("#3f9a1c2e");
  assert.equal(bare?.sessionId, "3f9a1c2e");
  assert.equal(bare?.harness, undefined);

  for (const junk of ["", "no reference here", "#xy", "####", "#", "# 3f9a1c2e"]) {
    assert.equal(ref.parseSessionRef(junk), null, `${JSON.stringify(junk)} → null`);
  }
});