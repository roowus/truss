import { test } from "node:test";
import assert from "node:assert/strict";
import { bootServer, type TestServer } from "./server-harness.js";

/* Route-level pins for the dialability guard on the OTHER two delivery
   routes (audit round at the merge head cf20ce1): /pair's refusal is pinned
   by the issue's own spec (return-address.test.ts); /taildrop and
   /ssh-install only had their #91 syntax guards pinned. Deleting either
   assertDialableServerUrl call site must fail CI — otherwise that path mints
   a doomed install again, which is the incident #100 exists to prevent. */

let srv: TestServer;

test.before(async () => {
  srv = await bootServer("delivery-dialable");
});
test.after(async () => {
  await srv?.close();
});

const DEAD = "http://192.0.2.55:4040"; // TEST-NET-1: syntax-valid, answers nowhere

async function mkHost() {
  const r = await fetch(`${srv.base}/api/hosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "pin rig" }),
  }).then((r) => r.json());
  return { id: r.host.id as string, token: r.token as string };
}

test("POST /api/hosts/:id/taildrop with an unreachable serverUrl refuses before touching the CLI", async () => {
  const { id, token } = await mkHost();
  const r = await fetch(`${srv.base}/api/hosts/${id}/taildrop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: "somebox", token, serverUrl: DEAD }),
  });
  assert.equal(r.status, 400, "the dead address is refused, not dropped");
  const body = await r.json().catch(() => ({}));
  assert.match(String(body?.error ?? ""), /reach|listen|serve|TRUSS_HOST/i, "the error guides");
});

test("POST /api/hosts/:id/ssh-install with an unreachable serverUrl refuses before touching the CLI", async () => {
  const { id, token } = await mkHost();
  const r = await fetch(`${srv.base}/api/hosts/${id}/ssh-install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: "somebox", token, serverUrl: DEAD }),
  });
  assert.equal(r.status, 400, "the dead address is refused, not executed on the peer");
  const body = await r.json().catch(() => ({}));
  assert.match(String(body?.error ?? ""), /reach|listen|serve|TRUSS_HOST/i, "the error guides");
});

test("GET /agent/install.sh without ?server= refuses a poisoned Host header", async () => {
  const { id } = await mkHost();
  /* fetch spec forbids overriding Host — go one level down (node:http) so a
     proxy-rewritten Host is really on the wire */
  const { get } = await import("node:http");
  const status = await new Promise<number>((res, rej) => {
    const req = get(`${srv.base}/agent/install.sh?host=${id}`, { headers: { host: "evil.example.com" } }, (r) => {
      r.resume();
      res(r.statusCode ?? 0);
    });
    req.on("error", rej);
  });
  assert.equal(status, 400, "a Host this server doesn't answer must not bake into the env file");
});
