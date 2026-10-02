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
