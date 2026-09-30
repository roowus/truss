import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./helpers.js";

/* SPEC-TESTS for the tailscale-serve 400 — https://github.com/roowus/truss/issues/37
   (User report: Settings → Network → "Tailscale serve" toggle fails with
   `400: sending serve config: Access denied: serve config denied`).
   These FAIL on purpose today: they pin the contract a fix must satisfy.

   Root cause (verified live on rewvis): tailscaled has NO operator set
   (`tailscale debug prefs` → OperatorUser: None) and truss runs as the
   non-root user `ubuntu` — tailscaled's LocalAPI refuses serve-config writes
   from non-root non-operators. The toggle can never work until
   `sudo tailscale set --operator=$USER`… and truss surfaces the raw stderr
   with zero guidance (index.ts:206-213 passes the error through).

   The contract (net.ts):
   - parsePrefsOperator(jsonText) — pure: OperatorUser out of
     `tailscale debug prefs` output; null when unset/missing; never throws on
     garbage;
   - canServeWith(operatorUser, username, isRoot) — pure matrix: root always;
     operator==user yes; operator==someone-else no; no operator + non-root no;
   - serveErrorHint(stderr) — the raw denial becomes an actionable message:
     names `sudo tailscale set --operator=<user>` and keeps the original text;
     unrelated errors pass through untouched;
   - netInfo().tailscale gains canServe (boolean | undefined when the probe
     is unavailable) so Settings can explain the toggle BEFORE it fails. */

test("parsePrefsOperator: reads OperatorUser, null when unset, never throws", async () => {
  const { cleanup } = await freshServer("serve-prefs");
  try {
    const net: any = await import("../src/net.js");
    assert.equal(typeof net.parsePrefsOperator, "function", "net.ts must export parsePrefsOperator — see issue #37");

    assert.equal(net.parsePrefsOperator(JSON.stringify({ OperatorUser: "ubuntu" })), "ubuntu");
    assert.equal(net.parsePrefsOperator(JSON.stringify({ OperatorUser: "" })), null, "empty operator = none");
    assert.equal(net.parsePrefsOperator(JSON.stringify({})), null, "field absent");
    for (const junk of ["", "not json", "[]", "null", '{"OperatorUser": 42}']) {
      assert.equal(net.parsePrefsOperator(junk), null, `${JSON.stringify(junk)} → null, never a crash`);
    }
  } finally {
    cleanup();
  }
});

test("canServeWith: root always; operator==user yes; operator-elsewhere no; no-operator non-root no", async () => {
  const { cleanup } = await freshServer("serve-matrix");
  try {
    const net: any = await import("../src/net.js");
    assert.equal(typeof net.canServeWith, "function", "net.ts must export canServeWith — see issue #37");

    assert.equal(net.canServeWith(null, "ubuntu", true), true, "root writes serve config");
    assert.equal(net.canServeWith("ubuntu", "ubuntu", false), true, "the operator can");
    assert.equal(net.canServeWith("alice", "ubuntu", false), false, "another user's operator lock");
    assert.equal(net.canServeWith(null, "ubuntu", false), false, "THE USER'S CASE: no operator + non-root → denied");
  } finally {
    cleanup();
  }
});

test("serveErrorHint: the denial gains the remediation; other errors pass through", async () => {
  const { cleanup } = await freshServer("serve-hint");
  try {
    const net: any = await import("../src/net.js");
    assert.equal(typeof net.serveErrorHint, "function", "net.ts must export serveErrorHint — see issue #37");

    const raw = "sending serve config: Access denied: serve config denied";
    const hint = net.serveErrorHint(raw, "ubuntu");
    assert.match(hint, /tailscale set --operator/, "names the fix");
    assert.ok(hint.includes("--operator=ubuntu") || hint.includes("--operator ubuntu"), "with the actual username filled in");
    assert.ok(hint.includes(raw), "the original error is kept for debugging");
    assert.match(hint, /Settings|Network|root/i, "points at the UI path or root alternative");

    const other = "backend not running";
    assert.equal(net.serveErrorHint(other, "ubuntu"), other, "unrelated errors stay verbatim");
  } finally {
    cleanup();
  }
});

test("netInfo surfaces tailscale.canServe (boolean when tailscale is installed)", async () => {
  const { cleanup } = await freshServer("serve-netinfo");
  try {
    const net: any = await import("../src/net.js");
    const info = await net.netInfo(4040);
    if (!info.tailscale.installed) return; // CI without tailscale: nothing to assert
    assert.equal(typeof info.tailscale.canServe, "boolean", "canServe reported (Settings greys/guides the toggle)");
    /* on the reporting box this is currently false (no operator, non-root) —
       the probe must agree with tailscaled's denial */
  } finally {
    cleanup();
  }
});
