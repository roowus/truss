import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { bootServer, type TestServer } from "./server-harness.js";

/* SPEC-TESTS for interactive pairing — https://github.com/roowus/truss/issues/111
   ("When adding a device even the sent-to-device command is so long —
   installing claude is just `install claude` then `claude`. Make it as
   simple as possible, use the existing tailscale connection."). These FAIL
   on purpose today: they pin the contract a fix must satisfy.

   What shipped so far (live-verified on the running instance): the wizard
   offers tailscale-ssh zero-typing / short-name taildrop / a pairing
   command (`curl …/i/<code> | sh`) — but the pairing command still embeds
   host + code inline, i.e. ~40+ chars to type on the remote.

   The claude-parity shape: `curl -fsSL <host>/i | sh` — the script itself
   PROMPTS for the 4-char code (nothing inline). On a taildrop, the dropped
   file can be exactly this script (type ~20 chars + a 4-char code — the
   floor without a daemon).

   The contract:
   1. GET /i (no code) → a shell script that (a) prompts for the code
      (read), (b) POSTs it to the redeem endpoint, (c) contains NO token
      (nothing sensitive until a valid code), (d) passes sh -n.
   2. POST /i/redeem { code } → one-shot JSON { hostId, token, serverUrl } —
      200 once, then 410; unknown codes 410; hammering 429 (the existing
      redeem rate limit). */

let srv: TestServer;
before(async () => {
  srv = await bootServer("pair-interactive");
});
after(async () => {
  await srv.close();
});

test("GET /i (no code) serves the interactive installer: prompts, redeems, carries no token", async () => {
  const res = await fetch(`${srv.base}/i`);
  assert.equal(res.status, 200, "the bare /i route exists (today it falls through to the SPA)");
  const body = await res.text();
  assert.match(res.headers.get("content-type") ?? "", /shellscript|x-sh|plain/i, "it's a script, not the app html");
  assert.ok(!body.includes("<!doctype html") && !body.includes("<html"), "NOT the SPA fallback");
  assert.match(body, /read .*code|code\?/i, "the script prompts for the code");
  assert.match(body, /\/i\/redeem/, "and posts it to the redeem endpoint");
  assert.ok(!/truss_agent_[0-9a-f]{10,}/.test(body), "no token is ever baked into the generic script");
  const syntax = spawnSync("sh", ["-n"], { input: body, encoding: "utf8" });
  assert.equal(syntax.status, 0, `sh -n parses it clean: ${syntax.stderr.slice(0, 120)}`);
});

test("POST /i/redeem: one-shot JSON credentials — 200 once, 410 after; unknown 410; hammering 429", async () => {
  const created = await fetch(`${srv.base}/api/hosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "interactive-pair box" }),
  }).then((r) => r.json());
  const hostId = created.host.id as string;
  const token = created.token as string;

  const minted = await fetch(`${srv.base}/api/hosts/${hostId}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, serverUrl: srv.base }),
  }).then((r) => r.json());
  assert.ok(minted.code, "the existing mint route stands");

  const once = await fetch(`${srv.base}/i/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: minted.code }),
  });
  assert.equal(once.status, 200, "first redeem hands over the credentials");
  const payload = await once.json();
  assert.equal(payload.hostId, hostId);
  assert.equal(payload.token, token, "the agent token for the env file");
  assert.equal(payload.serverUrl, srv.base, "the dial-home URL the wizard chose");

  const twice = await fetch(`${srv.base}/i/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: minted.code }),
  });
  assert.equal(twice.status, 410, "one-shot: a used code is dead");

  const ghost = await fetch(`${srv.base}/i/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "zzzz" }),
  });
  assert.equal(ghost.status, 410, "unknown codes die the same way (no oracle)");

  let last = 0;
  for (let i = 0; i < 9; i++) {
    last = (
      await fetch(`${srv.base}/i/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: `probe${i}` }),
      })
    ).status;
  }
  assert.equal(last, 429, "the redeem rate limit guards the endpoint (redeemRateOk)");
});
