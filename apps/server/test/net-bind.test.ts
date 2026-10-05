import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./helpers.js";

/* SPEC-TEST (server half) for dead wizard addresses —
   https://github.com/roowus/truss/issues/33
   (The add-host wizard offered http://<tailnet-ip>:4040 while the server
   listened on 127.0.0.1 only — connection refused from every device.)

   The wizard can only stop offering dead addresses if it can KNOW the bind.
   The contract: netInfo() reports it. */

test("netInfo reports the server's bind address (loopback vs all-interfaces)", async () => {
  const { cleanup } = await freshServer("net-bind");
  try {
    const net = await import("../src/net.js");
    /* the second parameter is the new contract — the cast keeps this file
       typechecking before it exists */
    const netInfo = net.netInfo as unknown as (port: number, bindHost?: string) => Promise<unknown>;
    const info = (await netInfo(4040, "127.0.0.1")) as { bind?: string };
    assert.equal(
      info.bind,
      "127.0.0.1",
      "netInfo must echo the bind it was given — the wizard's reachability filter reads this (issue #33)",
    );
    const all = (await netInfo(4040, "0.0.0.0")) as { bind?: string };
    assert.equal(all.bind, "0.0.0.0");
    /* omitted → the server's own default (TRUSS_HOST ?? 0.0.0.0) */
    const dflt = (await netInfo(4040)) as { bind?: string };
    assert.equal(typeof dflt.bind, "string", "bind present even when the arg is omitted");
  } finally {
    cleanup();
  }
});

test("TRUSS_PUBLIC_URL is the operator's declared front door (audit B2): surfaced and dialable on any bind", async () => {
  const { cleanup } = await freshServer("net-public");
  try {
    process.env.TRUSS_PUBLIC_URL = "https://truss.example.com";
    const net = await import("../src/net.js");

    const info = await net.netInfo(4040, "127.0.0.1");
    assert.equal(info.publicUrl, "https://truss.example.com", "netInfo surfaces it");

    /* a proxy/DNS front door is dialable even on a loopback bind — without
       this escape hatch, proxied deployments can't pair at all */
    net.assertDialableServerUrl("https://truss.example.com", {
      port: 4040,
      bind: "127.0.0.1",
      publicUrl: info.publicUrl,
      tailscale: { installed: false },
      lan: [],
    });
    /* trailing slash normalizes */
    net.assertDialableServerUrl("https://truss.example.com/", {
      port: 4040, bind: "127.0.0.1", publicUrl: "https://truss.example.com", tailscale: { installed: false }, lan: [],
    });
    /* …but it is not a wildcard: other off-host names still refuse */
    assert.throws(
      () => net.assertDialableServerUrl("https://other.example.com", { port: 4040, bind: "127.0.0.1", publicUrl: "https://truss.example.com", tailscale: { installed: false }, lan: [] }),
      /unreachable/,
    );
    delete process.env.TRUSS_PUBLIC_URL;
  } finally {
    delete process.env.TRUSS_PUBLIC_URL;
    cleanup();
  }
});
