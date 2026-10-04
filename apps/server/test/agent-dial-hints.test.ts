import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for agent dial failure guidance —
   https://github.com/roowus/truss/issues/100
   (The remote-host rework issue — user evidence: their agent looped
   `[node-agent] ws error: connect ECONNREFUSED 100.107.125.118:4040`
   forever with zero guidance). These FAIL on purpose today.

   The contract: packages/node-agent gains a pure diagnostic builder
   (imported here via the metrics.ts relative-import precedent) —

     dialFailureHint({ code, url, attempts }): string | null

   - after a few connection REFUSALS (or timeouts) on a ws(s) url, the log
     line names the likely cause + the two remediations (the server only
     listening on loopback / a dead tailnet path): "tailscale serve" and
     TRUSS_HOST. The user should never have to decode ECONNREFUSED;
   - early attempts stay quiet (a booting server is normal);
   - refusal to invent causes for non-connect errors (auth closes etc. have
     their own messages — the 4403/4404 paths already do). */

interface DialHintModule {
  dialFailureHint(input: { code: string; url: string; attempts: number }): string | null;
}

async function load(): Promise<DialHintModule | null> {
  /* node-agent has no test runner; import its source directly, same as
     metrics.test.ts does for packages/proto */
  const spec = "../../../packages/node-agent/src/dialHint.js"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

const URL = "ws://rewvis.tail208cbf.ts.net:4040";

test("packages/node-agent/src/dialHint.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "packages/node-agent must export dialFailureHint from src/dialHint.ts — see issue #100");
});

test("persistent refusal on a tailnet URL names the cause + both remediations", async () => {
  const mod = await load();
  assert.ok(mod, "dialHint module must exist (see module test)");

  const hint = mod.dialFailureHint({ code: "ECONNREFUSED", url: URL, attempts: 4 });
  assert.ok(hint, "the 4th refusal earns a hint");
  assert.ok(hint!.includes(URL), "names the address it's failing to reach");
  assert.match(hint!, /tailscale serve/i, "remediation one: serve on the tailnet");
  assert.match(hint!, /TRUSS_HOST|listen|bound|loopback|0\.0\.0\.0/i, "remediation two: the bind itself");
  assert.match(hint!, /ECONNREFUSED|refused/i, "and the raw cause is kept");

  const timeout = mod.dialFailureHint({ code: "ETIMEDOUT", url: URL, attempts: 5 });
  assert.ok(timeout && /tailnet|tailscale|network|firewall|offline/i.test(timeout), "timeouts point at the network path");
});

test("early attempts stay quiet; non-connect errors never get invented causes", async () => {
  const mod = await load();
  assert.ok(mod, "dialHint module must exist (see module test)");

  assert.equal(mod.dialFailureHint({ code: "ECONNREFUSED", url: URL, attempts: 1 }), null, "first refusal: could be a booting server");
  assert.equal(mod.dialFailureHint({ code: "ECONNREFUSED", url: URL, attempts: 2 }), null, "second too");
  assert.equal(mod.dialFailureHint({ code: "UND_ERR_SOCKET" as string, url: URL, attempts: 9 } as never), null, "non-refusal errors stay out of it");
  assert.equal(mod.dialFailureHint({ code: "EACCES", url: URL, attempts: 9 }), null);
});
