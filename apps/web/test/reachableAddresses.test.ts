import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for the wizard offering only reachable addresses —
   https://github.com/roowus/truss/issues/33
   (User log: the wizard's command pointed at http://rewvis.tail208cbf.ts.net:4040
   → "Failed to connect … port 4040" from the Mac; the server was bound to
   127.0.0.1 with tailscale serve off, so the tailnet address it offered was
   dead on arrival.) These FAIL on purpose today.

   The contract: a pure src/lib/reachability.ts —

     reachableAddresses(net: NetInfo & { bind?: string }): { value, label }[]

   filtering the address list the wizard offers (AddHostWizard's `addresses`
   memo) by the server's actual bind:
   - 0.0.0.0 / ::        → everything survives;
   - 127.0.0.1/::1       → only the tailscale-serve URL survives when serve is
     on (it proxies to loopback); raw tailnet/LAN addresses are dropped — a
     loopback-bound server answers NOTHING off-host;
   - a specific bind ip  → only entries at that ip survive;
   - the tailnet dns-name entry is equivalent to the tailnet ip entry;
   - nothing reachable → EMPTY list (the wizard then shows the "only
     listening on loopback — enable tailscale serve or restart with
     TRUSS_HOST=0.0.0.0" guidance — acceptance criteria), never a dead offer;
   - input order preserved. */

interface NetLike {
  port: number;
  bind?: string;
  tailscale: { installed: boolean; ip4?: string; dnsName?: string; serveOn?: boolean; serveUrl?: string };
  lan: string[];
}
interface Addr {
  value: string;
  label: string;
}
interface ReachModule {
  reachableAddresses(net: NetLike): Addr[];
}

async function load(): Promise<ReachModule | null> {
  const spec = "../src/lib/reachability"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

const NET = (bind: string, serveOn = false): NetLike => ({
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

test("src/lib/reachability.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/reachability.ts must export reachableAddresses — see issue #33");
});

test("bound to all interfaces: every address survives", async () => {
  const mod = await load();
  assert.ok(mod, "reachability module must exist (see module test)");
  const out = mod.reachableAddresses(NET("0.0.0.0"));
  const values = out.map((a) => a.value);
  assert.ok(values.some((v) => v.includes("100.107.125.118")), "tailnet ip offered");
  assert.ok(values.some((v) => v.includes("rewvis.tail208cbf.ts.net")), "tailnet name offered");
  assert.ok(values.some((v) => v.includes("192.168.1.10")), "lan offered");
});

test("THE USER'S CASE: loopback bind, serve off → nothing raw survives (no dead offers)", async () => {
  const mod = await load();
  assert.ok(mod, "reachability module must exist (see module test)");
  const out = mod.reachableAddresses(NET("127.0.0.1", false));
  assert.deepEqual(out, [], "a loopback-bound server answers nothing off-host — the wizard must not offer these");
});

test("loopback bind + tailscale serve on → only the serve URL survives", async () => {
  const mod = await load();
  assert.ok(mod, "reachability module must exist (see module test)");
  const out = mod.reachableAddresses(NET("127.0.0.1", true));
  assert.deepEqual(
    out.map((a) => a.value),
    ["https://rewvis.tail208cbf.ts.net"],
    "serve proxies to loopback — the one reachable address",
  );
});

test("a specific bind ip keeps only its own entries; loopback ipv6 treated as loopback", async () => {
  const mod = await load();
  assert.ok(mod, "reachability module must exist (see module test)");
  const onlyTail = mod.reachableAddresses(NET("100.107.125.118"));
  assert.ok(onlyTail.length > 0 && onlyTail.every((a) => a.value.includes("100.107.125.118") || a.value.includes("rewvis.tail208cbf.ts.net")), "bound to the tailnet ip: only tailnet entries");
  assert.deepEqual(mod.reachableAddresses(NET("::1", false)), [], "::1 is loopback too");
});
