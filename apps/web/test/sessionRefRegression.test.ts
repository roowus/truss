import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSessionRef, parseSessionRef } from "../src/lib/sessionRef";

/* REGRESSION PIN for the #13 contract (issue #132).
   ---------------------------------------------------------------------------
   The fix for #132 ADDS formatSessionRefFull(); it must not move
   formatSessionRef or parseSessionRef by a single byte — 6 landed tests pin
   the shape, and parse round-trips depend on it.

   Those 6 tests pin the shape by assertion. This pins it by GOLDEN VECTOR:
   the exact strings the #13 implementation emitted, frozen at the commit
   before #132 touched the file. They are the contract in its most literal
   form — if a future change reflows the separator, renames the host rule, or
   lets a field leak into the line, these fail even where the shape
   assertions would still pass.

   The vectors were produced by running the pre-#132 module
   (git show 021324f:apps/web/src/lib/sessionRef.ts) over the matrix below;
   no expected value here was written by hand from the implementation, and
   each was re-checked against that pre-#132 module before landing. */

const HOSTS = [
  { id: "6b260ee1", label: "fedora box" },
  { id: "525b9cd4", label: "devbox" },
];

/* [id, harness, cwd, hosts, expected one-liner] */
const VECTORS: [string, string, string, { id: string; label: string }[], string][] = [
  ["3f9a1c2e", "hermes", "/home/ubuntu/projects/truss", [], "#3f9a1c2e · hermes · ~/projects/truss"],
  ["aa07c1d9", "pi@6b260ee1", "/home/fedora/code/api", HOSTS, "#aa07c1d9 · pi @ fedora box · ~/code/api"],
  ["aa07c1d9", "pi@525b9cd4", "/Users/alice/projects/doubletake", HOSTS, "#aa07c1d9 · pi @ devbox · ~/projects/doubletake"],
  /* unknown host keeps the raw id — the reference stays resolvable */
  ["aa07c1d9", "pi@6b260ee1", "/home/fedora/code/api", [], "#aa07c1d9 · pi @ 6b260ee1 · ~/code/api"],
  /* local sessions carry no host part, whatever the cwd */
  ["3f9a1c2e", "claude-code", "/tmp", [], "#3f9a1c2e · claude-code · /tmp"],
  ["3f9a1c2e", "dsh", "/", [], "#3f9a1c2e · dsh · /"],
];

test("#13 one-liner: frozen golden vectors — byte-identity across the matrix", () => {
  for (const [id, harness, cwd, hosts, expected] of VECTORS) {
    assert.equal(
      formatSessionRef({ id, harness, cwd }, hosts),
      expected,
      `formatSessionRef(${JSON.stringify({ id, harness, cwd })}, ${JSON.stringify(hosts)})`,
    );
  }
});

test("#13 one-liner: golden vectors still parse back to their fields", () => {
  for (const [, , , , expected] of VECTORS) {
    const p = parseSessionRef(expected);
    assert.ok(p, `${expected} must parse`);
    assert.equal(expected.startsWith(`#${p!.sessionId}`), true);
  }
  /* the exact round-trip the landed suite asserts, kept here as the frozen
     end-to-end shape: format → parse → same fields */
  const remote = { id: "aa07c1d9", harness: "pi@6b260ee1", cwd: "/home/fedora/code/api" };
  const back = parseSessionRef(formatSessionRef(remote, HOSTS));
  assert.deepEqual(back, { sessionId: "aa07c1d9", harness: "pi", host: "fedora box", cwd: "~/code/api" });
});
