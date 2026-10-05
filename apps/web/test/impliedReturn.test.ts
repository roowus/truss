import { test } from "node:test";
import assert from "node:assert/strict";
import { reachableTailscaleReturn } from "../src/lib/reachability.js";

/* Regression test for the #33 hole, from the issue #100 audit (item 3):
   the wizard gated its implied tailnet return address on the reachable list
   being NON-EMPTY — but a specific non-loopback bind (say the LAN ip) leaves
   the LAN entry in the list while the tailnet URL is still dead. The wizard
   then silently implied an address the server can't answer, which is exactly
   how the user's frozen dead env file flowed.

   The contract: the tailnet return may only be implied when it is itself one
   of the reachable addresses. */

const NET = (bind: string, serveOn = false) => ({
  port: 4040,
  bind,
  tailscale: {
    installed: true,
    ip4: "100.107.125.118",
    dnsName: "rewvis.tail208cbf.ts.net",
    serveOn,
    serveUrl: serveOn ? "https://rewvis.tail208cbf.ts.net" : undefined,
  },
  lan: ["192.168.1.10"],
});

test("wildcard bind: the tailnet name is implied (it answers)", () => {
  assert.equal(reachableTailscaleReturn(NET("0.0.0.0")), "http://rewvis.tail208cbf.ts.net:4040");
});

test("THE HOLE: bound to the LAN ip, the tailnet return is dead — imply nothing", () => {
  /* the offer list still has the LAN entry (non-empty was the old gate)… */
  assert.equal(reachableTailscaleReturn(NET("192.168.1.10")), null, "a specific non-loopback bind must not imply the tailnet URL");
});

test("bound to the tailnet ip itself: the tailnet name aliases it, implied", () => {
  assert.equal(reachableTailscaleReturn(NET("100.107.125.118")), "http://rewvis.tail208cbf.ts.net:4040");
});

test("loopback bind: implied only when tailscale serve is on (it proxies in)", () => {
  assert.equal(reachableTailscaleReturn(NET("127.0.0.1", false)), null);
  assert.equal(reachableTailscaleReturn(NET("127.0.0.1", true)), "https://rewvis.tail208cbf.ts.net");
});

test("no tailscale on the server: nothing to imply", () => {
  const bare = NET("0.0.0.0");
  assert.equal(reachableTailscaleReturn({ ...bare, tailscale: { installed: false } }), null);
  assert.equal(reachableTailscaleReturn(null), null);
});
