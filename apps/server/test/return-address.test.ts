import { test } from "node:test";
import assert from "node:assert/strict";
import { bootServer, type TestServer } from "./server-harness.js";
import { freshServer } from "./helpers.js";

/* SPEC-TESTS for return-address validation — https://github.com/roowus/truss/issues/100
   (User's agent looped ECONNREFUSED forever: the installer's env froze
   TRUSS_SERVER=ws://<tailnet-ip>:4040 while the server listened on
   127.0.0.1 only. Syntax-valid, unreachable.) These FAIL on purpose today:
   they pin the contract a fix must satisfy.

   The hole: the delivery routes (/api/hosts/:id/pair, /taildrop) take
   `serverUrl` from the CLIENT and validate only its SYNTAX
   (assertSafeServerUrl, the #91 audit) — never whether THIS server can be
   answered there. The wizard's address picks are client-side. So a doomed
   address mints a doomed install and nothing pushes back.

   The contract (net.ts — it already owns bind/reachability probing):

     assertDialableServerUrl(serverUrl, net): void   // throws with guidance

   - valid iff the URL's host:port is something the server actually answers
     given net.bind: 0.0.0.0/:: → any local/tailnet/lan address + the serve
     URL; loopback → ONLY loopback or the serve URL (it proxies in);
     a specific bind ip → only that ip;
   - the throw names the remediation (tailscale serve / TRUSS_HOST);
   - syntax garbage stays rejected (the #91 audit's assertSafeServerUrl
     contract composes, not duplicates);

   and the routes (/pair, /taildrop) run it before minting anything —
   proven below against a real booted server bound to loopback. */

interface NetLike {
  port: number;
  bind?: string;
  tailscale: { installed: boolean; ip4?: string; dnsName?: string; serveOn?: boolean; serveUrl?: string };
  lan: string[];
}

const NET_LOOPBACK: NetLike = {
  port: 4040,
  bind: "127.0.0.1",
  tailscale: { installed: true, ip4: "100.107.125.118", dnsName: "rewvis.tail208cbf.ts.net", serveOn: false },
  lan: ["192.168.1.10"],
};

test("assertDialableServerUrl: the user's exact dead address rejects with remediation (loopback bind)", async () => {
  const { cleanup } = await freshServer("dialable");
  try {
    const net: any = await import("../src/net.js");
    assert.equal(typeof net.assertDialableServerUrl, "function", "net.ts must export assertDialableServerUrl — see issue #100");

    assert.throws(
      () => net.assertDialableServerUrl("http://rewvis.tail208cbf.ts.net:4040", NET_LOOPBACK),
      /reach|listen|serve|TRUSS_HOST|loopback/i,
      "the tailnet name on a loopback-bound server must refuse, with the fix named",
    );
    assert.throws(() => net.assertDialableServerUrl("http://100.107.125.118:4040", NET_LOOPBACK), /reach|listen|serve|TRUSS_HOST|loopback/i, "the tailnet ip too");
    assert.throws(() => net.assertDialableServerUrl("http://192.168.1.10:4040", NET_LOOPBACK), /reach|listen|serve/i, "even the LAN ip — loopback answers nothing off-loopback");

    /* what DOES pass on loopback */
    net.assertDialableServerUrl("http://127.0.0.1:4040", NET_LOOPBACK);
    const withServe = { ...NET_LOOPBACK, tailscale: { ...NET_LOOPBACK.tailscale, serveOn: true, serveUrl: "https://rewvis.tail208cbf.ts.net" } };
    net.assertDialableServerUrl("https://rewvis.tail208cbf.ts.net", withServe);

    /* all-interfaces bind: everything local passes */
    const wide = { ...NET_LOOPBACK, bind: "0.0.0.0" };
    net.assertDialableServerUrl("http://rewvis.tail208cbf.ts.net:4040", wide);
    net.assertDialableServerUrl("http://100.107.125.118:4040", wide);
    net.assertDialableServerUrl("http://192.168.1.10:4040", wide);
  } finally {
    cleanup();
  }
});

test("assertDialableServerUrl keeps the #91 syntax contract (garbage still dies)", async () => {
  const { cleanup } = await freshServer("dialable-syntax");
  try {
    const net: any = await import("../src/net.js");
    assert.equal(typeof net.assertDialableServerUrl, "function", "assertDialableServerUrl must exist (see the matrix test)");
    assert.throws(() => net.assertDialableServerUrl("not a url", NET_LOOPBACK), /url|syntax|safe|invalid/i);
    assert.throws(() => net.assertDialableServerUrl("http://x:4040/$(rm -rf ~)", NET_LOOPBACK), /url|syntax|safe|invalid|meta/i, "shell metacharacters stay rejected");
    assert.throws(() => net.assertDialableServerUrl("http://x:4040/' OR '", NET_LOOPBACK), /url|syntax|safe|invalid|quote/i);
  } finally {
    cleanup();
  }
});

/* ── route level, on a real booted server bound to loopback ── */

let srv: TestServer;

test("POST /api/hosts/:id/pair with an unreachable serverUrl refuses instead of minting a doomed code", async () => {
  srv = await bootServer("dialable-route");
  try {
    /* the harness boots with TRUSS_HOST=127.0.0.1 semantics; a made-up
       tailnet-style address is dead by construction here */
    const created = await fetch(`${srv.base}/api/hosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "doomed pairing box" }),
    }).then((r) => r.json());
    const { id, token } = { id: created.host.id as string, token: created.token as string };

    const doomed = await fetch(`${srv.base}/api/hosts/${id}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, serverUrl: "http://192.0.2.55:4040" }), // TEST-NET-1: syntax-valid, answers nowhere
    });
    assert.ok(
      [400, 409, 422].includes(doomed.status),
      `an unreachable return address must not mint a pairing code (got ${doomed.status}) — the user's Mac got exactly this code, installed it, and looped ECONNREFUSED forever`,
    );
    const body = await doomed.json().catch(() => ({}));
    assert.match(String(body?.error ?? ""), /reach|listen|serve|bind|TRUSS_HOST/i, "the error guides, not just refuses");

    /* sanity: the REAL address still pairs */
    const good = await fetch(`${srv.base}/api/hosts/${id}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, serverUrl: srv.base }),
    });
    assert.equal(good.status, 200, "the reachable address mints fine");
  } finally {
    await srv.close();
  }
});
