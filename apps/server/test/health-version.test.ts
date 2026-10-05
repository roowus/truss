import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bootServer, type TestServer } from "./server-harness.js";

/* SPEC-TESTS for deployment staleness being machine-checkable —
   https://github.com/roowus/truss/issues/135
   (User story: "I thought we fixed this — dsh/hermes show only the default
   model." The fix WAS merged; the running server was a day-old manual
   process while the systemd service crash-looped on EADDRINUSE (restart
   counter at 22) — the squatter won silently and the watcher reported
   success). These FAIL on purpose today: they pin the contract a fix must
   satisfy.

   Two pins:

   1. /health carries the running code's identity — a git commit sha (7+
      hex) or build id — so "is the fix live?" is one curl, and the watcher
      can compare before/after a restart. Never throws without git (a
      non-checkout deploy reports a null/unknown field, still 200).

   2. scripts/mainline-watch.sh must not declare victory into a squatter:
      after restarting the service it VERIFIES the listener actually
      changed/answers (and logs a loud failure when the port is squatted —
      EADDRINUSE in the journal means the restart didn't take). Read-through
      pin on the ops script. */

let srv: TestServer;
before(async () => {
  srv = await bootServer("health-version");
});
after(async () => {
  await srv.close();
});

test("/health carries the code identity (commit sha or build id)", async () => {
  const res = await fetch(`${srv.base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true, "the existing shape stands");
  const ident = body.commit ?? body.version ?? body.buildId;
  assert.ok(ident !== undefined, "health must carry a code identity (commit/version/buildId) — staleness must be one curl (issue #135)");
  if (ident !== null && ident !== "unknown") {
    assert.match(String(ident), /^[0-9a-f]{7,40}$|^\d+\.\d+\.\d+/, "a sha or semver — comparable");
  }
});

const WATCHER = new URL("../../../scripts/mainline-watch.sh", import.meta.url);

test("the mainline watcher verifies its restart actually took (no silent squatter victories)", () => {
  const src = readFileSync(WATCHER, "utf8");
  assert.ok(/systemctl restart/.test(src), "it restarts the service (existing behavior)");

  assert.ok(
    /curl[^\n]*\/health|\/health/.test(src) || /EADDRINUSE|squat|EADDR/.test(src),
    "after the restart it must CHECK that the new process actually owns the port — tonight the service crash-looped on EADDRINUSE (counter 22) while a stale manual process kept serving, and the watcher logged success (issue #135)",
  );
});
