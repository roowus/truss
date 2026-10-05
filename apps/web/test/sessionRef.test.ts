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

/* issue #132: the copyable reference should carry the FULL identity — every
   id we hold — not just the tweetable line. formatSessionRefFull adds a
   labeled block under the one-liner (which stays byte-identical so
   parseSessionRef round-trips it). */

interface SessionRefFullModule {
  formatSessionRefFull(meta: { id: string; harness: string; cwd: string; harnessRef?: string | null }, hosts?: unknown[]): string;
}

test("formatSessionRefFull: one-liner first (unchanged), then every id labeled — full cwd, no shortening", async () => {
  const spec = "../src/lib/sessionRef";
  const mod = (await import(spec).catch(() => null)) as (SessionRefFullModule & { formatSessionRef: (m: never, h?: never) => string; parseSessionRef: (t: string) => { sessionId: string } | null }) | null;
  assert.ok(mod, "sessionRef module must exist (see module test)");
  assert.equal(typeof mod.formatSessionRefFull, "function", "sessionRef.ts must export formatSessionRefFull — see issue #132");

  const meta = { id: "aa07c1d9", harness: "pi@525b9cd4", cwd: "/Users/rewis/projects/doubletake", harnessRef: "01a0edfd-6598-727a-99ee-15ab86352a3c" };
  const block = mod.formatSessionRefFull(meta as never, HOSTS as never);
  const lines = block.split("\n");

  assert.equal(lines[0], mod.formatSessionRef(meta as never, HOSTS as never), "line 1 is the tweetable line, byte-identical");
  const joined = lines.slice(1).join("\n");
  assert.match(joined, /truss[^\n]*aa07c1d9/i, "the truss id, labeled");
  assert.match(joined, /01a0edfd-6598-727a-99ee-15ab86352a3c/, "the harness-native uuid is there");
  assert.match(joined, /525b9cd4/, "the host id is there too");
  assert.ok(joined.includes("/Users/rewis/projects/doubletake"), "the FULL cwd — no ~ shortening in the details block");

  /* and the block still parses back to the session */
  assert.equal(mod.parseSessionRef(block)?.sessionId, "aa07c1d9", "a pasted full block still deep-links");
});

test("formatSessionRefFull: never fabricates — missing fields are simply absent", async () => {
  const spec = "../src/lib/sessionRef";
  const mod = (await import(spec).catch(() => null)) as SessionRefFullModule | null;
  assert.ok(mod, "sessionRef module must exist (see module test)");

  const local = mod.formatSessionRefFull({ id: "3f9a1c2e", harness: "pi", cwd: "/home/ubuntu/x" } as never);
  assert.ok(!local.includes("host id"), "local sessions carry no host id line");
  assert.ok(!/session:|harness id/i.test(local.split("\n").slice(1).join("\n")) || !/uuid|[0-9a-f]{8}-[0-9a-f]{4}/.test(local), "no fabricated harness id");

  const noRef = mod.formatSessionRefFull({ id: "aa07c1d9", harness: "pi@525b9cd4", cwd: "/x", harnessRef: null } as never);
  assert.ok(!noRef.includes("undefined") && !noRef.includes("null"), "no undefined/null leaks into the block");
  assert.match(noRef, /525b9cd4/, "the host id still shows when the harness ref is missing");
});
