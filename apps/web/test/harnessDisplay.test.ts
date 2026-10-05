import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for human harness ids — https://github.com/roowus/truss/issues/109
   ("Why do connected sessions say pi@525b9cd4 and not pi@rewissmacbookpro").
   These FAIL on purpose today: they pin the contract a fix must satisfy.

   Why it happens (investigated): most surfaces print the harness id
   VERBATIM — the new-session harness cards show `@{hostOf(id)}`
   (NewSessionDialog.tsx:112), the session-row tooltip prints s.harness
   (Sidebar.tsx:226), and the composer hints interpolate meta.harness raw
   (ChatPanel.tsx:623/631/735). Only the chat header chip resolves the label
   (deviceLabel, device.ts).

   The contract: one resolver for the whole app — extend src/lib/device.ts —

     harnessDisplay(harness: string, hosts: {id,label}[], aliases?: Record<string,string>): string

   - local harnesses ("pi", "dsh") pass through untouched;
   - remote with a known host → "pi@<label>" (the ALIAS wins when the user
     set one — the sidebar's alias-or-label rule);
   - remote with an unknown host → the raw id stays (still resolvable);
   - garbage in ("", "pi@", "@x", "pi@a@b", null-ish) never throws and never
     returns something misleading. */

interface DeviceModule {
  harnessDisplay(harness: string, hosts: { id: string; label: string }[], aliases?: Record<string, string>): string;
}

async function load(): Promise<DeviceModule | null> {
  const spec = "../src/lib/device"; // the module exists; the export is the contract
  const mod: any = await import(spec);
  return typeof mod?.harnessDisplay === "function" ? mod : null;
}

const HOSTS = [{ id: "525b9cd4", label: "Rewiss-MacBook-Pro" }];

test("device.ts exports harnessDisplay", async () => {
  const mod = await load();
  assert.ok(mod, "device.ts must export harnessDisplay(harness, hosts, aliases?) — see issue #109");
});

test("the resolution matrix: local passthrough, known → label, alias wins, unknown → raw id", async () => {
  const mod = await load();
  assert.ok(mod, "harnessDisplay must exist (see module test)");

  assert.equal(mod.harnessDisplay("pi", HOSTS), "pi", "local harnesses pass through");
  assert.equal(mod.harnessDisplay("hermes", HOSTS), "hermes");

  assert.equal(mod.harnessDisplay("pi@525b9cd4", HOSTS), "pi@Rewiss-MacBook-Pro", "the user's exact case");
  assert.equal(mod.harnessDisplay("dsh@525b9cd4", HOSTS, { "525b9cd4": "the macbook" }), "dsh@the macbook", "a set alias beats the label");
  assert.equal(mod.harnessDisplay("pi@deadbeef", HOSTS), "pi@deadbeef", "unknown host → raw id (never a lie)");
});

test("garbage never crashes nor misleads", async () => {
  const mod = await load();
  assert.ok(mod, "harnessDisplay must exist (see module test)");
  for (const junk of ["", "pi@", "@x", "pi@a@b", "   "]) {
    const out = mod.harnessDisplay(junk, HOSTS);
    assert.equal(typeof out, "string", `${JSON.stringify(junk)} → a string`);
    assert.ok(out.length > 0, "never blank");
  }
  assert.equal(mod.harnessDisplay("", []), "", '"" stays ""');
});
