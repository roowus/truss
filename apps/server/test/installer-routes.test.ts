import { test } from "node:test";
import assert from "node:assert/strict";
import { bootServer, type TestServer } from "./server-harness.js";

/* ROUTE-LEVEL tests for the installer-delivery endpoints (issue #1) and the
   chat-upload route (issue #2). The modules underneath are unit-tested in
   installer-delivery.test.ts / chat-uploads.test.ts — here the HTTP surface
   itself is pinned: the 400/403/404/410/429 branches, the verifyAgentToken
   gating on /pair and /taildrop, and the redeem→serve round trip.

   Order matters in one place: every GET /i/:code spends from the loopback
   client's shared rate budget, so the rate-limit test runs LAST and loops
   until the wall rather than assuming a fresh window. */

let srv: TestServer;
let host: { id: string };
let token: string;
let pairCode: string;

const post = (path: string, body: unknown) =>
  fetch(`${srv.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

test.before(async () => {
  srv = await bootServer("installer-routes");
  /* the redeem route serves the real bundled agent — build it once, up front */
  const { ensureAgentBundle } = await import("../src/agentbundle.js");
  await ensureAgentBundle();

  const created = await post("/api/hosts", { label: "route-test box" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  host = created.body.host;
  token = created.body.token;
});
test.after(async () => {
  await srv?.close();
});

test("POST /api/hosts/:id/pair: 400 on a missing body, 403 on a wrong token, 200 mints a typeable command", async () => {
  const missing = await post(`/api/hosts/${host.id}/pair`, {});
  assert.equal(missing.status, 400, "token and serverUrl are required");

  const wrong = await post(`/api/hosts/${host.id}/pair`, { token: "truss_agent_deadbeef", serverUrl: srv.base });
  assert.equal(wrong.status, 403, "a token that doesn't match this host never mints a code");

  const ok = await post(`/api/hosts/${host.id}/pair`, { token, serverUrl: srv.base });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.code, /^[a-hjkmnp-z2-9]{4,8}$/, "short, unambiguous, typeable");
  assert.ok(ok.body.expiresAt > Date.now(), "carries a future expiry");
  assert.equal(ok.body.command, `curl -fsSL ${srv.base}/i/${ok.body.code} | sh`);
  /* issue #111: the wizard's lead line — the interactive variant, same code
     at the prompt instead of inline (audit round 3: pin it, the web side's
     interface type can't catch a dropped field) */
  assert.equal(ok.body.interactiveCommand, `curl -fsSL ${srv.base}/i | sh`);
  pairCode = ok.body.code;
});

test("POST /api/hosts/:id/taildrop: 400 on a missing body, 403 on a wrong token — before the tailscale CLI is ever touched", async () => {
  const missing = await post(`/api/hosts/${host.id}/taildrop`, {});
  assert.equal(missing.status, 400, "peer, token and serverUrl are required");

  const wrong = await post(`/api/hosts/${host.id}/taildrop`, { peer: "someone.tail-example.ts.net", token: "truss_agent_deadbeef", serverUrl: srv.base });
  assert.equal(wrong.status, 403, "bad token — rejected before any file is written or sent");
});

test("GET /agent/install.sh without a host is a clean 400, not a crash", async () => {
  const r = await fetch(`${srv.base}/agent/install.sh`);
  assert.equal(r.status, 400);
  assert.match(await r.text(), /missing host/);
});

test("GET /i/:code with an unknown code is a plain 410 (no oracle)", async () => {
  const r = await fetch(`${srv.base}/i/nosuch`);
  assert.equal(r.status, 410);
  assert.match(await r.text(), /used up or expired/);
});

test("redeem round trip: GET /i/:code serves the standalone installer exactly once, then 410", async () => {
  assert.ok(pairCode, "the pair test minted a code");
  const first = await fetch(`${srv.base}/i/${pairCode}`);
  assert.equal(first.status, 200);
  assert.match(first.headers.get("content-type") ?? "", /shellscript/);
  /* issue #111 review: a browser landing here (from the /p pairing page)
     must DOWNLOAD the installer under the name the page tells the user to
     run — curl ignores the header, so the pipe-to-sh flow is unaffected */
  assert.match(first.headers.get("content-disposition") ?? "", /attachment; filename="t\.sh"/, "browsers download it as t.sh");
  const body = await first.text();
  assert.ok(body.startsWith("#!/bin/sh"), "a runnable installer");
  assert.ok(body.includes(`TOKEN="${token}"`), "the standalone variant embeds the token — zero-arg install");

  const second = await fetch(`${srv.base}/i/${pairCode}`);
  assert.equal(second.status, 410, "single-use — the code is burned");
});

test("POST /api/sessions/:id/upload: 404 for a ghost session, 400 without a payload, 200 stores into the workspace", async () => {
  const ghost = await post("/api/sessions/nope/upload", { name: "a.txt", dataBase64: "aGk=" });
  assert.equal(ghost.status, 404);

  const c = await post("/api/sessions", { harness: "pi", cwd: srv.dir, title: "upload-route" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const id = c.body.session.id;

  const empty = await post(`/api/sessions/${id}/upload`, {});
  assert.equal(empty.status, 400, "name and dataBase64 required");

  const ok = await post(`/api/sessions/${id}/upload`, { name: "../../evil.txt", dataBase64: Buffer.from("hi").toString("base64") });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.upload.name, "evil.txt", "hostile path neutralized to a basename at the route boundary");
  assert.ok(ok.body.upload.path.startsWith(".truss-uploads/"), "lands inside the session workspace");
});

test("GET /i/:code is rate-limited per client — a guessing run meets 429 (issue #1 security note)", async () => {
  const { REDEEM_RATE_MAX } = await import("../src/pairing.js");
  /* earlier tests in this file already spent a few attempts from the
     loopback client's budget; loop until the wall instead of assuming a
     fresh window */
  const statuses: number[] = [];
  for (let i = 0; i < REDEEM_RATE_MAX + 5 && !statuses.includes(429); i++) {
    const r = await fetch(`${srv.base}/i/probe${i}`);
    statuses.push(r.status);
    await r.text();
  }
  assert.ok(statuses.includes(429), `the budget shuts the door — got: ${statuses.join(",")}`);
  const wall = statuses.indexOf(429);
  assert.ok(
    statuses.slice(0, wall).every((s) => s === 410),
    "everything before the wall was a plain unknown-code 410",
  );
  assert.ok(
    statuses.slice(wall).every((s) => s === 429),
    "everything at and after the wall is 429",
  );
});
