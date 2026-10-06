import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshServer } from "./helpers.js";

/* SPEC-TESTS for the serve-on-443 collision — https://github.com/roowus/truss/issues/171
   (User story: clicked "turn on tailscale serve now" in truss → every
   *.rewis site died. Diagnosis (from the ops session): truss ran
   `tailscale serve --bg --https=443` on a machine where Caddy owns 443 —
   tailscaled took over TLS on 443 for the whole machine and Caddy was
   shadowed until `tailscale serve reset`). These FAIL on purpose today.

   The contract (net.ts):

     planServe({ port, port443Busy }): { httpsPort: number; warning: string | null }

   - 443 busy → the plan NEVER claims it: an alternate tailnet port (8443)
     + a warning that NAMES the conflict (so the UI can say "your other
     sites keep working; truss lives at :8443");
   - 443 free → the standard plan (443, no warning);
   - the toggle command uses the PLANNED port (never a hardcoded 443), and
     "off" targets the port actually serving (symmetry);
   - read-through: tailscaleServe consults the plan / a 443 probe. */

interface NetServeModule {
  planServe(input: { port: number; port443Busy: boolean }): { httpsPort: number; warning: string | null };
}

async function load(): Promise<NetServeModule | null> {
  const { cleanup } = await freshServer("serve-plan");
  try {
    const spec = "../src/net.js";
    const mod: any = await import(spec);
    return typeof mod?.planServe === "function" ? mod : null;
  } finally {
    cleanup();
  }
}

test("planServe: a busy 443 is never claimed — alternate port + a warning that names it", async () => {
  const mod = await load();
  assert.ok(mod, "net.ts must export planServe — see issue #171");

  const busy = mod.planServe({ port: 4040, port443Busy: true });
  assert.notEqual(busy.httpsPort, 443, "NEVER the busy port — that was tonight's outage");
  assert.ok(busy.httpsPort >= 1024 && busy.httpsPort <= 65535, "a real port");
  assert.ok(busy.warning && /443/.test(busy.warning) && /use|busy|occupi|shadow|another/i.test(busy.warning), `the warning names the conflict: ${JSON.stringify(busy.warning)}`);

  const free = mod.planServe({ port: 4040, port443Busy: false });
  assert.equal(free.httpsPort, 443, "free 443 → the standard clean URL");
  assert.equal(free.warning, null, "no noise when it's safe");
});

test("the toggle command rides the plan — no hardcoded 443 anywhere; off targets the serving port", async () => {
  const mod = await load();
  assert.ok(mod, "planServe must exist (see plan test)");
  assert.equal(typeof (mod as any).serveCommands, "function", "net.ts must export serveCommands(plan, port) — the command builder");

  const busy = mod.planServe({ port: 4040, port443Busy: true });
  const cmds = (mod as any).serveCommands(busy, 4040);
  assert.ok(Array.isArray(cmds.on) && cmds.on.every((c: string) => !c.includes("=443") && !c.endsWith(":443")), "the ON command never names 443 when the plan avoided it");
  assert.ok(cmds.on.some((c: string) => String(busy.httpsPort).length > 0 && c.includes(String(busy.httpsPort))), "the planned port is what's served");
  assert.ok(cmds.off.every((c: string) => c.includes(String(busy.httpsPort))), "OFF tears down the port actually serving — not a stale 443");

  const free = mod.planServe({ port: 4040, port443Busy: false });
  const freeCmds = (mod as any).serveCommands(free, 4040);
  assert.ok(freeCmds.on.some((c: string) => c.includes("443")), "free 443 → the standard command");
});

test("read-through: the live toggle consults the plan (the hardcoded --https=443 is gone)", () => {
  const src = readFileSync(new URL("../src/net.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function tailscaleServe"));
  assert.ok(
    /planServe\(/.test(fn) && !fn.includes('"--https=443"'),
    "tailscaleServe must plan around a busy 443 — today it hardcodes --https=443 and shadows whatever owns it (Caddy died tonight; issue #171)",
  );
});
