import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./helpers.js";

/* net.ts — reachability probe for the add-host wizard. netInfo() only runs
   READ-ONLY probes (`tailscale ip -4`, `status --json`, `serve status`) and
   swallows every failure, so it is safe to call for real. tailscaleServe()
   FLIPS `tailscale serve` state — a test must never do that to the dev box,
   so we only assert it rejects cleanly when the CLI is unavailable. */

test("netInfo echoes the port, lists private LAN IPv4s, never rejects", async () => {
  const { cleanup } = await freshServer("net-info");
  try {
    const net = await import("../src/net.js");
    const info = await net.netInfo(4321); // resolves even with no tailscale CLI

    assert.equal(info.port, 4321, "port is echoed back");

    assert.ok(Array.isArray(info.lan), "lan is an array");
    for (const ip of info.lan) {
      assert.equal(typeof ip, "string");
      assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/, "dotted-quad IPv4");
      assert.ok(!ip.startsWith("127."), "loopback excluded");
      assert.match(ip, /^(10\.|192\.168\.|172\.|100\.)/, "private/CGNAT ranges only");
    }

    assert.equal(typeof info.tailscale.installed, "boolean");
    if (info.tailscale.installed) {
      // this box has the CLI — probe fields are optional but must have the right shape
      assert.ok(info.tailscale.ip4 === undefined || typeof info.tailscale.ip4 === "string");
      assert.ok(info.tailscale.dnsName === undefined || typeof info.tailscale.dnsName === "string");
      assert.ok(info.tailscale.serveOn === undefined || typeof info.tailscale.serveOn === "boolean");
      assert.ok(info.tailscale.serveUrl === undefined || /^https:\/\//.test(info.tailscale.serveUrl));
    } else {
      assert.equal(info.tailscale.ip4, undefined, "no CLI -> no tailscale fields");
      assert.equal(info.tailscale.serveOn, undefined);
    }
  } finally {
    cleanup();
  }
});

test("tailscaleServe rejects cleanly when tailscale is unavailable (never flips real state)", async () => {
  const { cleanup } = await freshServer("net-serve");
  try {
    const net = await import("../src/net.js");
    const probe = await net.netInfo(4099);
    if (probe.tailscale.installed) {
      /* The CLI works on this machine, so calling tailscaleServe would mutate
         the REAL tailnet serve config — out of bounds for a test. The only
         safe assertion here is that netInfo's read-only probe agreed the CLI
         exists (covered above). Skip the mutation path deliberately. */
      return;
    }
    // no usable tailscale: both directions must reject (Error), not throw sync
    await assert.rejects(() => net.tailscaleServe(true, 4099));
    await assert.rejects(() => net.tailscaleServe(false, 4099));
  } finally {
    cleanup();
  }
});
