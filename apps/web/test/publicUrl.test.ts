import { test } from "node:test";
import assert from "node:assert/strict";
import { reachableAddresses } from "../src/lib/reachability.js";

/* audit B2 (issue #100): the dialability gate refuses anything the bind can't
   answer — so the operator-declared TRUSS_PUBLIC_URL (a proxy/DNS front door)
   must be offered by the wizard even on a loopback bind, or proxied
   deployments have no path at all. */

const LOOPBACK_NET = {
  port: 4040,
  bind: "127.0.0.1",
  publicUrl: "https://truss.example.com",
  tailscale: { installed: false },
  lan: ["192.168.1.10"],
};

test("the public URL survives a loopback bind; raw LAN still doesn't", () => {
  const out = reachableAddresses(LOOPBACK_NET);
  assert.deepEqual(out.map((a) => a.value), ["https://truss.example.com"]);
});

test("no publicUrl declared → unchanged behavior", () => {
  const { publicUrl: _omit, ...bare } = LOOPBACK_NET;
  assert.deepEqual(reachableAddresses(bare), []);
});
